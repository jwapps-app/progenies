"""Map a parsed GEDCOM document into database records for a tree.

Handles the notable GEDCOM edge cases:
  * Unknown spouses  -> a real Individual row with is_unknown=TRUE.
  * Multiple wives    -> one Family row per husband-wife pairing (GEDCOM already
                         models this as separate FAM records, which we preserve).
  * Missing dates     -> stored as NULL.
  * GEDCOM XREFs      -> preserved in gedcom_xref columns for round-trip fidelity.
"""
from __future__ import annotations

import hashlib

from sqlalchemy.orm import Session

from models import Child, Family, FamilyTree, GedcomFile, Individual, Source
from schemas import ImportSummary
from services.gedcom_parser import GedNode, parse_gedcom


def _split_name(name_value: str | None) -> tuple[str | None, str | None, str | None]:
    """Split a GEDCOM NAME ("Given Middle /Surname/") into (given, middle, surname).

    The GEDCOM given portion holds first + middle names with no separate tag, so
    we treat the first token as the given name and any remaining tokens as middle
    name(s). This round-trips losslessly: export re-joins them with a space.
    """
    if not name_value:
        return None, None, None
    if "/" in name_value:
        before, _, after = name_value.partition("/")
        surname_part, _, _ = after.partition("/")
        surname = surname_part.strip() or None
        given_part = before.strip()
    else:
        given_part = name_value.strip()
        surname = None

    given: str | None = None
    middle: str | None = None
    if given_part:
        tokens = given_part.split()
        given = tokens[0]
        if len(tokens) > 1:
            middle = " ".join(tokens[1:])
    return given, middle, surname


def _event(record: GedNode, tag: str) -> tuple[str | None, str | None]:
    """Return (date, place) for an event sub-record (e.g. BIRT, DEAT, MARR)."""
    node = record.child(tag)
    if node is None:
        return None, None
    return node.value_of("DATE"), node.value_of("PLAC")


def import_gedcom(db: Session, tree: FamilyTree, content: str, filename: str | None) -> ImportSummary:
    doc = parse_gedcom(content)
    warnings = list(doc.warnings)

    # Archive the raw upload for recovery/audit.
    db.add(
        GedcomFile(
            tree_id=tree.id,
            filename=filename,
            direction="import",
            content=content,
            file_hash=hashlib.sha256(content.encode("utf-8", "replace")).hexdigest(),
        )
    )

    # ----- Sources (SOUR) -------------------------------------------------
    source_by_xref: dict[str, Source] = {}
    sources_imported = 0
    for rec in doc.records_with_tag("SOUR"):
        if rec.xref is None:
            continue
        src = Source(
            tree_id=tree.id,
            title=rec.value_of("TITL"),
            author=rec.value_of("AUTH"),
            publisher=rec.value_of("PUBL"),
            date=rec.value_of("DATE"),
            notes=rec.value_of("NOTE"),
            gedcom_xref=rec.xref,
        )
        db.add(src)
        source_by_xref[rec.xref] = src
        sources_imported += 1

    # ----- Individuals (INDI) --------------------------------------------
    indi_by_xref: dict[str, Individual] = {}
    for rec in doc.records_with_tag("INDI"):
        if rec.xref is None:
            continue
        given, middle, surname = _split_name(rec.value_of("NAME"))
        # A NAME record tagged TYPE married carries the married surname.
        married_name: str | None = None
        for name_node in rec.children_with("NAME"):
            type_node = name_node.child("TYPE")
            if type_node is not None and (type_node.value or "").strip().lower() == "married":
                _, _, married_name = _split_name(name_node.value)
                break
        birth_date, birth_place = _event(rec, "BIRT")
        death_date, death_place = _event(rec, "DEAT")
        sex = rec.value_of("SEX")
        if sex not in ("M", "F"):
            sex = "U"
        indi = Individual(
            tree_id=tree.id,
            given_name=given,
            middle_name=middle,
            surname=surname,
            married_name=married_name,
            sex=sex,
            birth_date=birth_date,
            birth_place=birth_place,
            death_date=death_date,
            death_place=death_place,
            notes=rec.value_of("NOTE"),
            gedcom_xref=rec.xref,
            is_unknown=False,
        )
        db.add(indi)
        indi_by_xref[rec.xref] = indi

    db.flush()  # assign ids before wiring families

    # ----- Families (FAM) -------------------------------------------------
    unknown_spouses_created = 0
    children_links = 0
    families_imported = 0

    def _unknown_spouse(sex: str, partner: Individual | None) -> Individual:
        nonlocal unknown_spouses_created
        partner_name = ""
        if partner is not None:
            partner_name = " ".join(
                p for p in [partner.given_name, partner.surname] if p
            ).strip()
        role = "Wife" if sex == "F" else "Husband"
        label = f"Unknown {role} of {partner_name}".strip()
        placeholder = Individual(
            tree_id=tree.id,
            given_name=label,
            sex=sex,
            is_unknown=True,
        )
        db.add(placeholder)
        db.flush()
        unknown_spouses_created += 1
        return placeholder

    for rec in doc.records_with_tag("FAM"):
        if rec.xref is None:
            continue
        husb_ref = rec.value_of("HUSB")
        wife_ref = rec.value_of("WIFE")
        child_refs = [c.value for c in rec.children_with("CHIL") if c.value]

        husband = indi_by_xref.get(husb_ref) if husb_ref else None
        wife = indi_by_xref.get(wife_ref) if wife_ref else None

        # A family with children needs both parents represented; fill the
        # missing slot with an explicit unknown placeholder individual.
        if child_refs:
            if husband is None and wife is not None:
                husband = _unknown_spouse("M", wife)
            elif wife is None and husband is not None:
                wife = _unknown_spouse("F", husband)

        married_date, married_place = _event(rec, "MARR")
        div_node = rec.child("DIV")
        divorced_date = div_node.value_of("DATE") if div_node is not None else None

        fam = Family(
            tree_id=tree.id,
            husband_id=husband.id if husband else None,
            wife_id=wife.id if wife else None,
            married_date=married_date,
            married_place=married_place,
            divorced_date=divorced_date,
            notes=rec.value_of("NOTE"),
            gedcom_xref=rec.xref,
        )
        db.add(fam)
        db.flush()
        families_imported += 1

        for order, child_xref in enumerate(child_refs, start=1):
            child_indi = indi_by_xref.get(child_xref)
            if child_indi is None:
                warnings.append(f"Family {rec.xref}: child {child_xref} not found; skipped")
                continue
            db.add(Child(family_id=fam.id, individual_id=child_indi.id, birth_order=order))
            children_links += 1

    db.commit()

    return ImportSummary(
        individuals_imported=len(indi_by_xref),
        families_imported=families_imported,
        children_links=children_links,
        sources_imported=sources_imported,
        unknown_spouses_created=unknown_spouses_created,
        warnings=warnings,
    )
