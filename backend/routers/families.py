"""Family CRUD routes. Each husband-wife pairing is its own family record."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, selectinload

from auth.deps import get_accessible_tree, get_editable_tree, require_in_tree
from database import get_db
from models import Child, Family, FamilyTree, Individual
from routers.visualization import _ANCESTOR_CTE, MAX_GENERATIONS
from schemas import ChildRef, FamilyCreate, FamilyOut, FamilyUpdate

router = APIRouter(prefix="/api/trees/{tree_id}/families", tags=["families"])


def _invalid(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=detail)


def _validate_member(db: Session, tree: FamilyTree, individual_id: uuid.UUID | None) -> None:
    if individual_id is None:
        return
    require_in_tree(
        db,
        tree,
        Individual,
        individual_id,
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail=f"Individual {individual_id} not found in this tree",
    )


def _parents(fam: Family) -> set[uuid.UUID]:
    return {p for p in (fam.husband_id, fam.wife_id) if p is not None}


def _reject_distinct_parents(fam: Family) -> None:
    """A person can't be married to themselves. (The merge route can produce
    such a row transiently and repairs it itself; the API must never accept one.)"""
    if fam.husband_id is not None and fam.husband_id == fam.wife_id:
        raise _invalid("Husband and wife cannot be the same person")


def _reject_parent_as_child(fam: Family, child_ids: set[uuid.UUID]) -> None:
    """A person cannot be their own parent: a child that is also this family's
    husband or wife would create a self-loop every tree traversal then has to
    defend against."""
    for pid in _parents(fam) & child_ids:
        raise _invalid(
            f"Individual {pid} is a parent in this family and cannot also be its child"
        )


def _reject_ancestry_cycle(db: Session, tree: FamilyTree, fam: Family, child_ids: set[uuid.UUID]) -> None:
    """No child may be an ancestor of either parent — otherwise the pedigree
    becomes a loop (A's parent is B, whose parent is A), which every ancestor
    walk then only survives by hitting its depth cap.

    Reuses the visualization's ancestor CTE: from each parent, walk child ->
    parents upward (tree-scoped, generation-bounded) and check whether any of
    this family's children shows up in that closure. Runs AFTER the family's
    own rows are flushed, so it sees the state that would be committed."""
    if not child_ids:
        return
    for pid in _parents(fam):
        ancestors = {
            row.individual_id
            for row in db.execute(
                _ANCESTOR_CTE, {"root": pid, "tree": tree.id, "max_gen": MAX_GENERATIONS}
            ).all()
        }
        looped = ancestors & child_ids
        if looped:
            raise _invalid(
                f"Individual {next(iter(looped))} is an ancestor of a parent in this "
                "family and cannot also be its child"
            )


def _sync_children(db: Session, fam: Family, refs: list[ChildRef], tree: FamilyTree) -> None:
    """Replace the family's child links with the provided set."""
    # Validate every referenced child in ONE query (a per-child db.get was N+1).
    if refs:
        wanted: set[uuid.UUID] = set()
        for ref in refs:
            # (family_id, individual_id) is the primary key — a repeated id
            # would surface as a database error (500) instead of a 422.
            if ref.individual_id in wanted:
                raise _invalid(f"Individual {ref.individual_id} is listed as a child more than once")
            wanted.add(ref.individual_id)
        _reject_parent_as_child(fam, wanted)
        found = set(
            db.scalars(
                select(Individual.id).where(
                    Individual.id.in_(wanted), Individual.tree_id == tree.id
                )
            )
        )
        missing = wanted - found
        if missing:
            raise _invalid(f"Individual {next(iter(missing))} not found in this tree")
    # Clear existing links in ONE statement (a per-row db.delete loop was N
    # round trips), then add the new set.
    db.execute(delete(Child).where(Child.family_id == fam.id))
    db.flush()
    for ref in refs:
        db.add(
            Child(
                family_id=fam.id,
                individual_id=ref.individual_id,
                birth_order=ref.birth_order,
                relation=ref.relation,
            )
        )


def _current_child_ids(db: Session, fam: Family) -> set[uuid.UUID]:
    return set(db.scalars(select(Child.individual_id).where(Child.family_id == fam.id)))


@router.get("", response_model=list[FamilyOut])
def list_families(
    tree: FamilyTree = Depends(get_accessible_tree), db: Session = Depends(get_db)
) -> list[Family]:
    # selectinload avoids one lazy children query PER family during serialization.
    stmt = (
        select(Family)
        .where(Family.tree_id == tree.id)
        .options(selectinload(Family.children))
    )
    return list(db.scalars(stmt))


@router.post("", response_model=FamilyOut, status_code=status.HTTP_201_CREATED)
def create_family(
    payload: FamilyCreate,
    tree: FamilyTree = Depends(get_editable_tree),
    db: Session = Depends(get_db),
) -> Family:
    _validate_member(db, tree, payload.husband_id)
    _validate_member(db, tree, payload.wife_id)
    marriage_order = payload.marriage_order
    if marriage_order is None:
        # Default to the next position among the bloodline person's marriages.
        anchor_id = payload.husband_id or payload.wife_id
        if anchor_id is not None:
            existing = db.scalar(
                select(func.count())
                .select_from(Family)
                .where(
                    Family.tree_id == tree.id,
                    (Family.husband_id == anchor_id) | (Family.wife_id == anchor_id),
                )
            )
            marriage_order = existing + 1
        else:
            marriage_order = 1
    fam = Family(
        tree_id=tree.id,
        husband_id=payload.husband_id,
        wife_id=payload.wife_id,
        married_date=payload.married_date,
        married_place=payload.married_place,
        divorced_date=payload.divorced_date,
        notes=payload.notes,
        marriage_order=marriage_order,
        gap=payload.gap,
        unmarried=payload.unmarried,
        gedcom_xref=payload.gedcom_xref,
    )
    _reject_distinct_parents(fam)
    db.add(fam)
    db.flush()
    _sync_children(db, fam, payload.children, tree)
    db.flush()
    _reject_ancestry_cycle(db, tree, fam, {ref.individual_id for ref in payload.children})
    db.commit()
    db.refresh(fam)
    return fam


@router.get("/{family_id}", response_model=FamilyOut)
def get_family(
    family_id: uuid.UUID,
    tree: FamilyTree = Depends(get_accessible_tree),
    db: Session = Depends(get_db),
) -> Family:
    return require_in_tree(db, tree, Family, family_id)


@router.put("/{family_id}", response_model=FamilyOut)
def update_family(
    family_id: uuid.UUID,
    payload: FamilyUpdate,
    tree: FamilyTree = Depends(get_editable_tree),
    db: Session = Depends(get_db),
) -> Family:
    fam = require_in_tree(db, tree, Family, family_id)
    data = payload.model_dump(exclude_unset=True)
    children = data.pop("children", None)
    if "husband_id" in data:
        _validate_member(db, tree, data["husband_id"])
    if "wife_id" in data:
        _validate_member(db, tree, data["wife_id"])
    for field, value in data.items():
        setattr(fam, field, value)
    _reject_distinct_parents(fam)
    if children is not None:
        _sync_children(db, fam, [ChildRef(**c) for c in children], tree)
    db.flush()
    # Checked against the family's children as they now stand — whether or not
    # this request touched them. Changing only husband_id to one of the
    # existing children used to slip through because the child check lived
    # inside _sync_children.
    child_ids = _current_child_ids(db, fam)
    _reject_parent_as_child(fam, child_ids)
    _reject_ancestry_cycle(db, tree, fam, child_ids)
    db.commit()
    db.refresh(fam)
    return fam


@router.delete("/{family_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_family(
    family_id: uuid.UUID,
    tree: FamilyTree = Depends(get_editable_tree),
    db: Session = Depends(get_db),
) -> None:
    fam = require_in_tree(db, tree, Family, family_id)
    db.delete(fam)
    db.commit()
