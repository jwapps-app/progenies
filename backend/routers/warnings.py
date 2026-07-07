"""Dismissed data-integrity warnings — issues the user has reviewed and accepted."""
from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth.deps import get_accessible_tree, get_editable_tree
from database import get_db
from models import DismissedWarning, FamilyTree
from schemas import WarningKeyRequest

router = APIRouter(prefix="/api/trees/{tree_id}/warnings", tags=["warnings"])


@router.get("/dismissed", response_model=list[str])
def list_dismissed(
    tree: FamilyTree = Depends(get_accessible_tree), db: Session = Depends(get_db)
) -> list[str]:
    return list(
        db.scalars(
            select(DismissedWarning.warning_key).where(DismissedWarning.tree_id == tree.id)
        )
    )


@router.post("/dismiss", status_code=status.HTTP_204_NO_CONTENT)
def dismiss(
    payload: WarningKeyRequest,
    tree: FamilyTree = Depends(get_editable_tree),
    db: Session = Depends(get_db),
) -> None:
    existing = db.get(DismissedWarning, {"tree_id": tree.id, "warning_key": payload.key})
    if existing is None:
        db.add(DismissedWarning(tree_id=tree.id, warning_key=payload.key))
        try:
            db.commit()
        except IntegrityError:  # concurrent dismiss of the same key — already done
            db.rollback()


@router.post("/undismiss", status_code=status.HTTP_204_NO_CONTENT)
def undismiss(
    payload: WarningKeyRequest,
    tree: FamilyTree = Depends(get_editable_tree),
    db: Session = Depends(get_db),
) -> None:
    existing = db.get(DismissedWarning, {"tree_id": tree.id, "warning_key": payload.key})
    if existing is not None:
        db.delete(existing)
        db.commit()
