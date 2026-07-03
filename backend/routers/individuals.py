"""Individual CRUD routes scoped to an owned tree."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth.deps import get_owned_tree
from database import get_db
from models import Child, Citation, Family, FamilyTree, Individual
from schemas import IndividualCreate, IndividualOut, IndividualUpdate, MergeRequest

router = APIRouter(prefix="/api/trees/{tree_id}/individuals", tags=["individuals"])


def _get_individual(db: Session, tree: FamilyTree, individual_id: uuid.UUID) -> Individual:
    indi = db.get(Individual, individual_id)
    if indi is None or indi.tree_id != tree.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Individual not found")
    return indi


@router.get("", response_model=list[IndividualOut])
def list_individuals(
    tree: FamilyTree = Depends(get_owned_tree), db: Session = Depends(get_db)
) -> list[Individual]:
    stmt = (
        select(Individual)
        .where(Individual.tree_id == tree.id)
        .order_by(Individual.surname, Individual.given_name)
    )
    return list(db.scalars(stmt))


@router.post("", response_model=IndividualOut, status_code=status.HTTP_201_CREATED)
def create_individual(
    payload: IndividualCreate,
    tree: FamilyTree = Depends(get_owned_tree),
    db: Session = Depends(get_db),
) -> Individual:
    indi = Individual(tree_id=tree.id, **payload.model_dump())
    db.add(indi)
    db.commit()
    db.refresh(indi)
    return indi


@router.get("/{individual_id}", response_model=IndividualOut)
def get_individual(
    individual_id: uuid.UUID,
    tree: FamilyTree = Depends(get_owned_tree),
    db: Session = Depends(get_db),
) -> Individual:
    return _get_individual(db, tree, individual_id)


@router.put("/{individual_id}", response_model=IndividualOut)
def update_individual(
    individual_id: uuid.UUID,
    payload: IndividualUpdate,
    tree: FamilyTree = Depends(get_owned_tree),
    db: Session = Depends(get_db),
) -> Individual:
    indi = _get_individual(db, tree, individual_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(indi, field, value)
    db.commit()
    db.refresh(indi)
    return indi


@router.delete("/{individual_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_individual(
    individual_id: uuid.UUID,
    tree: FamilyTree = Depends(get_owned_tree),
    db: Session = Depends(get_db),
) -> None:
    indi = _get_individual(db, tree, individual_id)
    # Families this person is a partner in — after deletion the DB sets their
    # husband/wife reference to NULL, which can leave a meaningless "ghost"
    # family (one or zero partners and no children). Clean those up.
    affected = list(
        db.scalars(
            select(Family).where(
                Family.tree_id == tree.id,
                (Family.husband_id == indi.id) | (Family.wife_id == indi.id),
            )
        )
    )
    db.delete(indi)
    db.flush()  # applies ON DELETE SET NULL to the affected families
    for fam in affected:
        db.refresh(fam)
        partners = [p for p in (fam.husband_id, fam.wife_id) if p is not None]
        has_children = db.scalar(select(Child.individual_id).where(Child.family_id == fam.id))
        if len(partners) < 2 and has_children is None:
            db.delete(fam)
    db.commit()


_MERGE_FILL_FIELDS = (
    "given_name",
    "middle_name",
    "surname",
    "birth_date",
    "birth_place",
    "death_date",
    "death_place",
    "age",
    "notes",
    "gedcom_xref",
)


@router.post("/{individual_id}/merge", status_code=status.HTTP_204_NO_CONTENT)
def merge_individual(
    individual_id: uuid.UUID,
    payload: MergeRequest,
    tree: FamilyTree = Depends(get_owned_tree),
    db: Session = Depends(get_db),
) -> None:
    """Merge the `duplicate_id` record into the survivor (`individual_id`):
    re-point all family/child/citation references, fill the survivor's blank
    fields from the duplicate, then delete the duplicate."""
    survivor = _get_individual(db, tree, individual_id)
    dup = _get_individual(db, tree, payload.duplicate_id)
    if survivor.id == dup.id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Cannot merge a person into themselves"
        )

    # Fill the survivor's empty fields from the duplicate.
    for field in _MERGE_FILL_FIELDS:
        if not getattr(survivor, field) and getattr(dup, field):
            setattr(survivor, field, getattr(dup, field))
    if survivor.sex in (None, "U") and dup.sex not in (None, "U"):
        survivor.sex = dup.sex
    if not dup.is_unknown:
        survivor.is_unknown = False

    # Re-point family partner slots from the duplicate to the survivor.
    for fam in db.scalars(
        select(Family).where(
            Family.tree_id == tree.id,
            (Family.husband_id == dup.id) | (Family.wife_id == dup.id),
        )
    ):
        if fam.husband_id == dup.id:
            fam.husband_id = survivor.id
        if fam.wife_id == dup.id:
            fam.wife_id = survivor.id
    db.flush()

    # Re-point child links (avoiding a duplicate link in the same family).
    for ch in list(db.scalars(select(Child).where(Child.individual_id == dup.id))):
        already = db.get(Child, {"family_id": ch.family_id, "individual_id": survivor.id})
        if already is None:
            db.add(
                Child(
                    family_id=ch.family_id,
                    individual_id=survivor.id,
                    birth_order=ch.birth_order,
                    relation=ch.relation,
                )
            )
        db.delete(ch)

    # Re-point citations.
    for cit in db.scalars(select(Citation).where(Citation.individual_id == dup.id)):
        cit.individual_id = survivor.id
    db.flush()

    # The merge can create a self-marriage (survivor married the duplicate) — drop it.
    for fam in list(
        db.scalars(
            select(Family).where(
                Family.tree_id == tree.id,
                Family.husband_id == survivor.id,
                Family.wife_id == survivor.id,
            )
        )
    ):
        db.delete(fam)

    db.delete(dup)
    db.commit()
