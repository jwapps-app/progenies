"""Dismissed duplicate pairs — people the user confirmed are NOT the same person."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth.deps import get_accessible_tree, get_editable_tree, require_in_tree
from database import get_db
from models import DismissedDuplicate, FamilyTree, Individual
from schemas import DismissedPairOut, DuplicatePairRequest

router = APIRouter(prefix="/api/trees/{tree_id}/duplicates", tags=["duplicates"])


def _sorted_pair(a: uuid.UUID, b: uuid.UUID) -> tuple[uuid.UUID, uuid.UUID]:
    return (a, b) if str(a) < str(b) else (b, a)


def _require_member(db: Session, tree: FamilyTree, iid: uuid.UUID) -> None:
    require_in_tree(
        db,
        tree,
        Individual,
        iid,
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail=f"Individual {iid} not found in this tree",
    )


@router.get("/dismissed", response_model=list[DismissedPairOut])
def list_dismissed(
    tree: FamilyTree = Depends(get_accessible_tree), db: Session = Depends(get_db)
) -> list[DismissedDuplicate]:
    return list(
        db.scalars(select(DismissedDuplicate).where(DismissedDuplicate.tree_id == tree.id))
    )


@router.post("/dismiss", status_code=status.HTTP_204_NO_CONTENT)
def dismiss(
    payload: DuplicatePairRequest,
    tree: FamilyTree = Depends(get_editable_tree),
    db: Session = Depends(get_db),
) -> None:
    if payload.id_a == payload.id_b:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Same person")
    a, b = _sorted_pair(payload.id_a, payload.id_b)
    _require_member(db, tree, a)
    _require_member(db, tree, b)
    existing = db.get(
        DismissedDuplicate, {"tree_id": tree.id, "individual_a": a, "individual_b": b}
    )
    if existing is None:
        db.add(DismissedDuplicate(tree_id=tree.id, individual_a=a, individual_b=b))
        try:
            db.commit()
        except IntegrityError:  # concurrent dismiss of the same pair — already done
            db.rollback()


@router.post("/undismiss", status_code=status.HTTP_204_NO_CONTENT)
def undismiss(
    payload: DuplicatePairRequest,
    tree: FamilyTree = Depends(get_editable_tree),
    db: Session = Depends(get_db),
) -> None:
    a, b = _sorted_pair(payload.id_a, payload.id_b)
    existing = db.get(
        DismissedDuplicate, {"tree_id": tree.id, "individual_a": a, "individual_b": b}
    )
    if existing is not None:
        db.delete(existing)
        db.commit()
