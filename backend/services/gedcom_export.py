"""Serialize a tree's records back into GEDCOM 5.5 text.

Reconstruction order: HEAD -> INDI -> FAM -> SOUR -> TRLR. XREFs are reused
from `gedcom_xref` when present (round-trip fidelity); otherwise stable new
xrefs are generated for records created inside the app. A stored xref that
appears twice (legacy double imports) is only honoured once — the second
record gets a fresh id, so the output never contains duplicate record ids.

App data without a standard GEDCOM 5.5 tag rides on custom tags (leading
underscore, preserved by any spec-compliant reader):
  _UNKNOWN Y   on INDI — unknown-spouse placeholder
  _ORDER n     on FAM  — marriage order (1st/2nd/3rd spouse)
  _GAP Y       on FAM  — unknown-depth descendant link
  _UNMAR Y     on FAM  — co-parents who are not married
Child relations use the standard PEDI tag under the child's FAMC link, and
source citations are emitted as SOUR links under each INDI.
"""
from __future__ import annotations

import hashlib

from sqlalchemy import select
from sqlalchemy.orm import Session

from config import settings
from models import Child, Citation, Family, FamilyTree, GedcomFile, Individual, Source

# GEDCOM 5.5 caps physical lines at 255 chars; chunk conservatively below that.
_MAX_SEGMENT = 232


def _line(level: int, tag: str, value: str | None = None, escape: bool = False) -> str:
    if value is None or value == "":
        return f"{level} {tag}"
    out_lines: list[str] = []
    for i, seg in enumerate(str(value).split("\n")):
        if escape and seg.startswith("@"):
            # Spec: a literal @ at the start of a value is doubled so readers
            # don't mistake it for a pointer. The parser folds @@ back to @.
            seg = "@" + seg
        # CONC-split long segments so no physical line exceeds the 255 limit.
        head, rest = seg[:_MAX_SEGMENT], seg[_MAX_SEGMENT:]
        if i == 0:
            out_lines.append(f"{level} {tag} {head}" if head else f"{level} {tag}")
        else:
            out_lines.append(f"{level + 1} CONT {head}" if head else f"{level + 1} CONT")
        while rest:
            chunk, rest = rest[:_MAX_SEGMENT], rest[_MAX_SEGMENT:]
            out_lines.append(f"{level + 1} CONC {chunk}")
    return "\n".join(out_lines)


def _assign_xrefs(items: list, prefix: str) -> dict:
    """Map each record id -> an xref, reusing stored ones, generating the rest.

    A stored xref is honoured only for its FIRST holder — duplicates (from
    legacy double imports) get generated ids, keeping the output unambiguous.
    """
    mapping: dict = {}
    used: set[str] = set()
    pending = []
    for item in items:
        if item.gedcom_xref and item.gedcom_xref not in used:
            mapping[item.id] = item.gedcom_xref
            used.add(item.gedcom_xref)
        else:
            pending.append(item)
    counter = 1
    for item in pending:
        while f"@{prefix}{counter}@" in used:
            counter += 1
        xref = f"@{prefix}{counter}@"
        used.add(xref)
        mapping[item.id] = xref
        counter += 1
    return mapping


def export_gedcom(db: Session, tree: FamilyTree, archive: bool = True) -> str:
    individuals = list(
        db.scalars(select(Individual).where(Individual.tree_id == tree.id).order_by(Individual.created_at))
    )
    # Deterministic family order, marriage_order first: FAMS order is how other
    # software infers 1st/2nd marriage, and a stable order keeps repeated
    # exports byte-identical (the archive dedupes on the content hash).
    families = list(
        db.scalars(
            select(Family)
            .where(Family.tree_id == tree.id)
            .order_by(Family.marriage_order.is_(None), Family.marriage_order, Family.id)
        )
    )
    sources = list(db.scalars(select(Source).where(Source.tree_id == tree.id).order_by(Source.id)))

    indi_xref = _assign_xrefs(individuals, "I")
    fam_xref = _assign_xrefs(families, "F")
    sour_xref = _assign_xrefs(sources, "S")

    # Precompute which families each individual belongs to (FAMS spouse / FAMC
    # child — the child side carries its relation for the PEDI tag).
    spouse_in: dict = {iid: [] for iid in indi_xref}
    child_in: dict = {iid: [] for iid in indi_xref}
    for fam in families:
        fx = fam_xref[fam.id]
        if fam.husband_id in spouse_in:
            spouse_in[fam.husband_id].append(fx)
        if fam.wife_id in spouse_in:
            spouse_in[fam.wife_id].append(fx)
    # One query for all families' children (a per-family loop here was an N+1).
    children_by_family: dict = {fam.id: [] for fam in families}
    if families:
        for kid in db.scalars(
            select(Child)
            .where(Child.family_id.in_(list(children_by_family)))
            .order_by(Child.family_id, Child.birth_order)
        ):
            children_by_family[kid.family_id].append(kid)
            if kid.individual_id in child_in:
                child_in[kid.individual_id].append((fam_xref[kid.family_id], kid.relation))

    # Source citations per individual (one query).
    citations_by_indi: dict = {}
    if individuals:
        for cit in db.scalars(
            select(Citation).where(Citation.individual_id.in_(list(indi_xref)))
        ):
            citations_by_indi.setdefault(cit.individual_id, []).append(cit)

    lines: list[str] = []

    # ----- HEAD -----------------------------------------------------------
    app_name = settings.APP_NAME
    lines += [
        "0 HEAD",
        f"1 SOUR {app_name.replace(' ', '_')}",
        f"2 NAME {app_name} Genealogy PWA",
        "2 VERS 1.0",
        "1 GEDC",
        "2 VERS 5.5",
        "2 FORM LINEAGE-LINKED",
        "1 CHAR UTF-8",
    ]

    # ----- INDI -----------------------------------------------------------
    for indi in individuals:
        xref = indi_xref[indi.id]
        lines.append(f"0 {xref} INDI")
        # GEDCOM given portion = given + middle name(s); surname in slashes.
        given_part = " ".join(p for p in [indi.given_name, indi.middle_name] if p).strip()
        name = f"{given_part} /{indi.surname}/".strip() if indi.surname else given_part
        lines.append(_line(1, "NAME", name or None))
        if indi.nickname:
            lines.append(_line(2, "NICK", indi.nickname))
        # Married name: a second NAME record tagged TYPE married (GEDCOM 5.5.1),
        # with the acquired surname in slashes so other software round-trips it.
        if indi.married_name:
            married = f"{given_part} /{indi.married_name}/".strip()
            lines.append(_line(1, "NAME", married))
            lines.append(_line(2, "TYPE", "married"))
        if indi.sex:
            lines.append(_line(1, "SEX", indi.sex))
        if indi.birth_date or indi.birth_place:
            lines.append("1 BIRT")
            if indi.birth_date:
                lines.append(_line(2, "DATE", indi.birth_date))
            if indi.birth_place:
                lines.append(_line(2, "PLAC", indi.birth_place))
        if indi.death_date or indi.death_place:
            lines.append("1 DEAT")
            if indi.death_date:
                lines.append(_line(2, "DATE", indi.death_date))
            if indi.death_place:
                lines.append(_line(2, "PLAC", indi.death_place))
        for fx in spouse_in.get(indi.id, []):
            lines.append(_line(1, "FAMS", fx))
        for fx, relation in child_in.get(indi.id, []):
            lines.append(_line(1, "FAMC", fx))
            if relation and relation != "biological":
                lines.append(_line(2, "PEDI", relation))
        for cit in citations_by_indi.get(indi.id, []):
            sx = sour_xref.get(cit.source_id)
            if sx is None:
                continue
            lines.append(_line(1, "SOUR", sx))
            if cit.page:
                lines.append(_line(2, "PAGE", cit.page))
            if cit.notes:
                lines.append(_line(2, "NOTE", cit.notes, escape=True))
        if indi.notes:
            lines.append(_line(1, "NOTE", indi.notes, escape=True))
        if indi.is_unknown:
            lines.append(_line(1, "_UNKNOWN", "Y"))

    # ----- FAM ------------------------------------------------------------
    for fam in families:
        xref = fam_xref[fam.id]
        lines.append(f"0 {xref} FAM")
        if fam.husband_id and fam.husband_id in indi_xref:
            lines.append(_line(1, "HUSB", indi_xref[fam.husband_id]))
        if fam.wife_id and fam.wife_id in indi_xref:
            lines.append(_line(1, "WIFE", indi_xref[fam.wife_id]))
        for kid in children_by_family.get(fam.id, []):
            if kid.individual_id in indi_xref:
                lines.append(_line(1, "CHIL", indi_xref[kid.individual_id]))
        if fam.married_date or fam.married_place:
            lines.append("1 MARR")
            if fam.married_date:
                lines.append(_line(2, "DATE", fam.married_date))
            if fam.married_place:
                lines.append(_line(2, "PLAC", fam.married_place))
        if fam.divorced_date:
            lines.append("1 DIV")
            lines.append(_line(2, "DATE", fam.divorced_date))
        if fam.notes:
            lines.append(_line(1, "NOTE", fam.notes, escape=True))
        if fam.marriage_order is not None:
            lines.append(_line(1, "_ORDER", str(fam.marriage_order)))
        if fam.gap:
            lines.append(_line(1, "_GAP", "Y"))
        if fam.unmarried:
            lines.append(_line(1, "_UNMAR", "Y"))

    # ----- SOUR -----------------------------------------------------------
    for src in sources:
        lines.append(f"0 {sour_xref[src.id]} SOUR")
        if src.title:
            lines.append(_line(1, "TITL", src.title))
        if src.author:
            lines.append(_line(1, "AUTH", src.author))
        if src.publisher:
            lines.append(_line(1, "PUBL", src.publisher))
        if src.date:
            lines.append(_line(1, "DATE", src.date))
        if src.notes:
            lines.append(_line(1, "NOTE", src.notes, escape=True))

    lines.append("0 TRLR")
    text = "\n".join(lines) + "\n"

    if archive:
        file_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        # Only archive when the content actually changed — clicking export
        # repeatedly was appending a full copy of the tree every time.
        latest = db.scalar(
            select(GedcomFile.file_hash)
            .where(GedcomFile.tree_id == tree.id, GedcomFile.direction == "export")
            .order_by(GedcomFile.created_at.desc())
            .limit(1)
        )
        if latest != file_hash:
            db.add(
                GedcomFile(
                    tree_id=tree.id,
                    filename=f"{tree.name}.ged",
                    direction="export",
                    content=text,
                    file_hash=file_hash,
                )
            )
            db.commit()

    return text
