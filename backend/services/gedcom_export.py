"""Serialize a tree's records back into GEDCOM 5.5 text.

Reconstruction order: HEAD -> INDI -> FAM -> SOUR -> TRLR. XREFs are reused
from `gedcom_xref` when present (round-trip fidelity); otherwise stable new
xrefs are generated for records created inside the app.
"""
from __future__ import annotations

import hashlib

from sqlalchemy import select
from sqlalchemy.orm import Session

from config import settings
from models import Child, Family, FamilyTree, GedcomFile, Individual, Source


def _line(level: int, tag: str, value: str | None = None) -> str:
    if value is None or value == "":
        return f"{level} {tag}"
    # GEDCOM 5.5: split multi-line values across CONT.
    lines = str(value).split("\n")
    out = f"{level} {tag} {lines[0]}"
    for extra in lines[1:]:
        out += f"\n{level + 1} CONT {extra}"
    return out


def _assign_xrefs(items: list, prefix: str) -> dict:
    """Map each record id -> an xref, reusing stored ones, generating the rest."""
    mapping: dict = {}
    used: set[str] = {i.gedcom_xref for i in items if i.gedcom_xref}
    counter = 1
    for item in items:
        if item.gedcom_xref:
            mapping[item.id] = item.gedcom_xref
            continue
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
    families = list(
        db.scalars(select(Family).where(Family.tree_id == tree.id))
    )
    sources = list(db.scalars(select(Source).where(Source.tree_id == tree.id)))

    indi_xref = _assign_xrefs(individuals, "I")
    fam_xref = _assign_xrefs(families, "F")
    sour_xref = _assign_xrefs(sources, "S")

    # Precompute which families each individual belongs to (FAMS spouse / FAMC child).
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
                child_in[kid.individual_id].append(fam_xref[kid.family_id])

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
        for fx in child_in.get(indi.id, []):
            lines.append(_line(1, "FAMC", fx))
        if indi.notes:
            lines.append(_line(1, "NOTE", indi.notes))

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
            lines.append(_line(1, "NOTE", fam.notes))

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
            lines.append(_line(1, "NOTE", src.notes))

    lines.append("0 TRLR")
    text = "\n".join(lines) + "\n"

    if archive:
        db.add(
            GedcomFile(
                tree_id=tree.id,
                filename=f"{tree.name}.ged",
                direction="export",
                content=text,
                file_hash=hashlib.sha256(text.encode("utf-8")).hexdigest(),
            )
        )
        db.commit()

    return text
