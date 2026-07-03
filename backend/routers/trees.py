"""Tree management routes: create, list, get, update, soft-delete."""
from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth.deps import get_current_user, get_owned_tree
from database import get_db
from models import FamilyTree, User
from schemas import TreeCreate, TreeOut, TreeUpdate

router = APIRouter(prefix="/api/trees", tags=["trees"])


@router.get("", response_model=list[TreeOut])
def list_trees(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[FamilyTree]:
    stmt = (
        select(FamilyTree)
        .where(FamilyTree.user_id == user.id, FamilyTree.is_deleted.is_(False))
        .order_by(FamilyTree.created_at.desc())
    )
    return list(db.scalars(stmt))


@router.post("", response_model=TreeOut, status_code=status.HTTP_201_CREATED)
def create_tree(
    payload: TreeCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> FamilyTree:
    tree = FamilyTree(user_id=user.id, name=payload.name, description=payload.description)
    db.add(tree)
    db.commit()
    db.refresh(tree)
    return tree


@router.get("/{tree_id}", response_model=TreeOut)
def get_tree(tree: FamilyTree = Depends(get_owned_tree)) -> FamilyTree:
    return tree


@router.put("/{tree_id}", response_model=TreeOut)
def update_tree(
    payload: TreeUpdate,
    tree: FamilyTree = Depends(get_owned_tree),
    db: Session = Depends(get_db),
) -> FamilyTree:
    if payload.name is not None:
        tree.name = payload.name
    if payload.description is not None:
        tree.description = payload.description
    db.commit()
    db.refresh(tree)
    return tree


@router.delete("/{tree_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tree(tree: FamilyTree = Depends(get_owned_tree), db: Session = Depends(get_db)) -> None:
    # Soft-delete per the API contract.
    tree.is_deleted = True
    db.commit()
