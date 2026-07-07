"""Map a parsed GEDCOM document into database records for a tree.

Handles the notable GEDCOM edge cases:
  * Unknown spouses  -> a real Individual row with is_unknown=TRUE (marked with
                        a custom _UNKNOWN tag on export so it round-trips).
  * Multiple wives    -> one Family row per husband-wife pairing (GEDCOM already
                         models this as separate FAM records, which we preserve).
  * Missing dates     -> stored as NULL.
  * GEDCOM XREFs      -> preserved in gedcom_xref columns for round-trip fidelity.
                         An incoming xref that already exists in the tree (e.g.
                         two files both starting at @I1@) is NOT stored — export
                         generates a fresh one — so exports never emit duplicate
                         record ids.
  * Child relation    -> PEDI under the child's FAMC link (adopted/foster/step;
                         "birth" maps to biological).
  * Shared notes      -> NOTE pointer records (1 NOTE @N1@) are dereferenced.
  * Citations         -> level-1 SOUR links under INDI become Citation rows.
  * App-only fields   -> marriage_order/gap/unmarried round-trip via custom
                         _ORDER/_GAP/_UNMAR tags on FAM records.

Record ids are assigned application-side (uuid4) at construction, so nothing
needs a flush to be referenced — a large import is one flush+commit instead of
a round trip per family.
"""
from __future__ import annotations

import hashlib
import re
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import Child, Citation, Family, FamilyTree, GedcomFile, Individual, Source
from schemas import ImportSummary
from services.gedcom_parser import GedNode, parse_gedcom

_POINTER = re.compile(r"^@[^@]+@$")
_RELATIONS = {"biological", "adopted", "step", "foster"}


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


def _flag(record: GedNode, tag: str) -> bool:
    node = record.child(tag)
    return node is not None and (node.value or "Y").strip().upper() in ("Y", "YES", "TRUE", "1")


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

    # Shared note records: `1 NOTE @N1@` points at `0 @N1@ NOTE <text>`. Without
    # dereferencing, the literal string "@N1@" would be stored as the note.
    note_by_xref = {
        rec.xref: rec.value for rec in doc.records_with_tag("NOTE") if rec.xref is not None
    }

    def _notes(record: GedNode) -> str | None:
        """All NOTE children (not just the first), pointers dereferenced."""
        parts: list[str] = []
        for node in record.children_with("NOTE"):
            value = node.value or ""
            if _POINTER.match(value.strip()):
                value = note_by_xref.get(value.strip(), value)
            if value:
                parts.append(value)
        return "\n\n".join(parts) or None

    # Importing into a tree that already has records with the same xrefs (two
    # files both starting at @I1@) must not store duplicates — export would
    # emit two `0 @I1@ INDI` records. Colliding incoming xrefs are dropped
    # (export will generate fresh ones); in-file pointer resolution is
    # unaffected because it uses the document's own dict, not the stored value.
    existing_xrefs: set[str] = set()
    for model in (Individual, Family, Source):
        existing_xrefs.update(
            x
            for x in db.scalars(
                select(model.gedcom_xref).where(model.tree_id == tree.id, model.gedcom_xref.is_not(None))
            )
        )
    collided = 0

    def _storable_xref(xref: str) -> str | None:
        nonlocal collided
        if xref in existing_xrefs:
            collided += 1
            return None
        existing_xrefs.add(xref)
        return xref

    # ----- Sources (SOUR) -------------------------------------------------
    source_by_xref: dict[str, Source] = {}
    sources_imported = 0
    for rec in doc.records_with_tag("SOUR"):
        if rec.xref is None:
            continue
        src = Source(
            id=uuid.uuid4(),
            tree_id=tree.id,
            title=rec.value_of("TITL"),
            author=rec.value_of("AUTH"),
            publisher=rec.value_of("PUBL"),
            date=rec.value_of("DATE"),
            notes=_notes(rec),
            gedcom_xref=_storable_xref(rec.xref),
        )
        db.add(src)
        source_by_xref[rec.xref] = src
        sources_imported += 1

    # ----- Individuals (INDI) --------------------------------------------
    indi_by_xref: dict[str, Individual] = {}
    # (child xref, family xref) -> relation, from PEDI under the FAMC link.
    relation_by_link: dict[tuple[str, str], str] = {}
    citations_imported = 0
    for rec in doc.records_with_tag("INDI"):
        if rec.xref is None:
            continue
        if rec.xref in indi_by_xref:
            warnings.append(f"Duplicate individual xref {rec.xref}; keeping the first record")
            continue
        # The primary NAME is the first one NOT tagged TYPE married — some files
        # list the married name first, and taking it as the birth name would
        # swap the maiden name away.
        name_nodes = rec.children_with("NAME")
        primary = next(
            (
                n
                for n in name_nodes
                if (n.value_of("TYPE") or "").strip().lower() != "married"
            ),
            name_nodes[0] if name_nodes else None,
        )
        given, middle, surname = _split_name(primary.value if primary else None)
        nickname = (primary.value_of("NICK") if primary else None) or None
        married_name: str | None = None
        for name_node in name_nodes:
            if (name_node.value_of("TYPE") or "").strip().lower() == "married":
                _, _, married_name = _split_name(name_node.value)
                break
        birth_date, birth_place = _event(rec, "BIRT")
        death_date, death_place = _event(rec, "DEAT")
        # Absent SEX stays NULL (round-trips); junk normalizes to U.
        raw_sex = rec.value_of("SEX")
        sex = raw_sex.strip().upper()[:1] if raw_sex else None
        if sex is not None and sex not in ("M", "F", "U"):
            sex = "U"
        is_unknown = _flag(rec, "_UNKNOWN")
        indi = Individual(
            id=uuid.uuid4(),
            tree_id=tree.id,
            given_name=given,
            middle_name=middle,
            surname=surname,
            married_name=married_name,
            nickname=nickname,
            sex=sex,
            birth_date=birth_date,
            birth_place=birth_place,
            death_date=death_date,
            death_place=death_place,
            notes=_notes(rec),
            gedcom_xref=_storable_xref(rec.xref),
            is_unknown=is_unknown,
        )
        db.add(indi)
        indi_by_xref[rec.xref] = indi

        # Child relation: PEDI under this person's FAMC link(s).
        for famc in rec.children_with("FAMC"):
            if not famc.value:
                continue
            pedi = (famc.value_of("PEDI") or "").strip().lower()
            if not pedi:
                continue
            relation = "biological" if pedi == "birth" else pedi
            if relation not in _RELATIONS:
                relation = "biological"
            relation_by_link[(rec.xref, famc.value.strip())] = relation

        # Source citations: level-1 SOUR pointers under the individual.
        for cit_node in rec.children_with("SOUR"):
            pointer = (cit_node.value or "").strip()
            src = source_by_xref.get(pointer)
            if src is None:
                if pointer:
                    warnings.append(f"Individual {rec.xref}: source {pointer} not found; citation skipped")
                continue
            db.add(
                Citation(
                    id=uuid.uuid4(),
                    source_id=src.id,
                    individual_id=indi.id,
                    page=cit_node.value_of("PAGE"),
                    notes=cit_node.value_of("NOTE"),
                )
            )
            citations_imported += 1

    # ----- Families (FAM) -------------------------------------------------
    unknown_spouses_created = 0
    children_links = 0
    families_imported = 0
    seen_fam_xrefs: set[str] = set()

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
            id=uuid.uuid4(),
            tree_id=tree.id,
            given_name=label,
            sex=sex,
            is_unknown=True,
        )
        db.add(placeholder)
        unknown_spouses_created += 1
        return placeholder

    for rec in doc.records_with_tag("FAM"):
        if rec.xref is None:
            continue
        if rec.xref in seen_fam_xrefs:
            warnings.append(f"Duplicate family xref {rec.xref}; keeping the first record")
            continue
        seen_fam_xrefs.add(rec.xref)
        husb_ref = rec.value_of("HUSB")
        wife_ref = rec.value_of("WIFE")
        child_refs = [c.value for c in rec.children_with("CHIL") if c.value]

        husband = indi_by_xref.get(husb_ref) if husb_ref else None
        wife = indi_by_xref.get(wife_ref) if wife_ref else None
        if husb_ref and husband is None:
            warnings.append(f"Family {rec.xref}: husband {husb_ref} not found")
        if wife_ref and wife is None:
            warnings.append(f"Family {rec.xref}: wife {wife_ref} not found")
        if husband is not None and husband is wife:
            warnings.append(f"Family {rec.xref}: husband and wife are the same person")

        # A family with children needs both parents represented; fill the
        # missing slot with an explicit unknown placeholder individual.
        if child_refs:
            if husband is None and wife is not None:
                husband = _unknown_spouse("M", wife)
            elif wife is None and husband is not None:
                wife = _unknown_spouse("F", husband)

        if husband is None and wife is None and not child_refs:
            warnings.append(f"Family {rec.xref}: no resolvable members; skipped")
            continue

        married_date, married_place = _event(rec, "MARR")
        div_node = rec.child("DIV")
        divorced_date = div_node.value_of("DATE") if div_node is not None else None
        order_raw = rec.value_of("_ORDER")
        try:
            marriage_order = int(order_raw) if order_raw else None
        except ValueError:
            marriage_order = None

        fam = Family(
            id=uuid.uuid4(),
            tree_id=tree.id,
            husband_id=husband.id if husband else None,
            wife_id=wife.id if wife else None,
            married_date=married_date,
            married_place=married_place,
            divorced_date=divorced_date,
            notes=_notes(rec),
            gedcom_xref=_storable_xref(rec.xref),
            marriage_order=marriage_order,
            gap=_flag(rec, "_GAP"),
            unmarried=_flag(rec, "_UNMAR"),
        )
        db.add(fam)
        families_imported += 1

        for order, child_xref in enumerate(child_refs, start=1):
            child_indi = indi_by_xref.get(child_xref)
            if child_indi is None:
                warnings.append(f"Family {rec.xref}: child {child_xref} not found; skipped")
                continue
            relation = relation_by_link.get((child_xref, rec.xref), "biological")
            db.add(
                Child(
                    family_id=fam.id,
                    individual_id=child_indi.id,
                    birth_order=order,
                    relation=relation,
                )
            )
            children_links += 1

    if collided:
        warnings.append(
            f"{collided} record id(s) already existed in this tree; the new copies "
            "will receive fresh ids on export"
        )
    if citations_imported:
        warnings.append(f"Imported {citations_imported} source citation(s)")

    db.commit()

    return ImportSummary(
        individuals_imported=len(indi_by_xref),
        families_imported=families_imported,
        children_links=children_links,
        sources_imported=sources_imported,
        unknown_spouses_created=unknown_spouses_created,
        warnings=warnings,
    )
