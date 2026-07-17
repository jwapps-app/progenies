"""Family CRUD routes. Each husband-wife pairing is its own family record."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from auth.deps import get_accessible_tree, get_editable_tree, require_in_tree
from database import get_db
from models import Child, Family, FamilyTree, Individual
from schemas import ChildRef, FamilyCreate, FamilyOut, FamilyUpdate

router = APIRouter(prefix="/api/trees/{tree_id}/families", tags=["families"])


def _validate_member(db: Session, tree: FamilyTree, individual_id: uuid.UUID | None) -> None:
    if individual_id is None:
        return
    require_in_tree(
        db,
        tree,
        Individual,
        individual_id,
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail=f"Individual {individual_id} not found in this tree",
    )


def _sync_children(db: Session, fam: Family, refs: list[ChildRef], tree: FamilyTree) -> None:
    """Replace the family's child links with the provided set."""
    # Validate every referenced child in ONE query (a per-child db.get was N+1).
    if refs:
        # A person cannot be their own parent: a child ref naming this family's
        # husband or wife would create a self-loop every tree traversal then
        # has to defend against.
        parents = {p for p in (fam.husband_id, fam.wife_id) if p is not None}
        for ref in refs:
            if ref.individual_id in parents:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"Individual {ref.individual_id} is a parent in this family and cannot also be its child",
                )
        wanted = {ref.individual_id for ref in refs}
        found = set(
            db.scalars(
                select(Individual.id).where(
                    Individual.id.in_(wanted), Individual.tree_id == tree.id
                )
            )
        )
        missing = wanted - found
        if missing:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Individual {next(iter(missing))} not found in this tree",
            )
    # Clear existing links, then add the new set.
    for existing in list(fam.children):
        db.delete(existing)
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
    )
    db.add(fam)
    db.flush()
    _sync_children(db, fam, payload.children, tree)
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
    if children is not None:
        _sync_children(db, fam, [ChildRef(**c) for c in children], tree)
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
