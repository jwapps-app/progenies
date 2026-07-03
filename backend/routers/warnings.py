"""Dismissed data-integrity warnings — issues the user has reviewed and accepted."""
from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth.deps import get_owned_tree
from database import get_db
from models import DismissedWarning, FamilyTree
from schemas import WarningKeyRequest

router = APIRouter(prefix="/api/trees/{tree_id}/warnings", tags=["warnings"])


@router.get("/dismissed", response_model=list[str])
def list_dismissed(
    tree: FamilyTree = Depends(get_owned_tree), db: Session = Depends(get_db)
) -> list[str]:
    return list(
        db.scalars(
            select(DismissedWarning.warning_key).where(DismissedWarning.tree_id == tree.id)
        )
    )


@router.post("/dismiss", status_code=status.HTTP_204_NO_CONTENT)
def dismiss(
    payload: WarningKeyRequest,
    tree: FamilyTree = Depends(get_owned_tree),
    db: Session = Depends(get_db),
) -> None:
    existing = db.get(DismissedWarning, {"tree_id": tree.id, "warning_key": payload.key})
    if existing is None:
        db.add(DismissedWarning(tree_id=tree.id, warning_key=payload.key))
        db.commit()


@router.post("/undismiss", status_code=status.HTTP_204_NO_CONTENT)
def undismiss(
    payload: WarningKeyRequest,
    tree: FamilyTree = Depends(get_owned_tree),
    db: Session = Depends(get_db),
) -> None:
    existing = db.get(DismissedWarning, {"tree_id": tree.id, "warning_key": payload.key})
    if existing is not None:
        db.delete(existing)
        db.commit()
