"""Tree management: create, list, get, update, soft-delete, and sharing.

A tree has one owner (family_trees.user_id) plus any number of collaborators
(tree_shares). Owners can do everything, including managing who a tree is shared
with; collaborators get 'editor' (read + write) or 'viewer' (read-only) access.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth.deps import get_accessible_tree, get_current_user, get_owned_tree, tree_role
from database import get_db
from models import FamilyTree, TreeShare, User
from schemas import ShareCreate, ShareOut, TreeCreate, TreeOut, TreeUpdate

router = APIRouter(prefix="/api/trees", tags=["trees"])


def _tree_out(tree: FamilyTree, role: str, owner_username: str | None) -> TreeOut:
    return TreeOut(
        id=tree.id,
        name=tree.name,
        description=tree.description,
        created_at=tree.created_at,
        updated_at=tree.updated_at,
        role=role,
        owner_username=owner_username,
    )


@router.get("", response_model=list[TreeOut])
def list_trees(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> list[TreeOut]:
    """Trees the user owns, plus trees shared with them (each tagged with the
    user's role and, for shared trees, the owner's username)."""
    owned = db.scalars(
        select(FamilyTree)
        .where(FamilyTree.user_id == user.id, FamilyTree.is_deleted.is_(False))
        .order_by(FamilyTree.created_at.desc())
    ).all()
    result = [_tree_out(t, "owner", user.username) for t in owned]

    shared = db.execute(
        select(FamilyTree, TreeShare.role, User.username)
        .join(TreeShare, TreeShare.tree_id == FamilyTree.id)
        .join(User, User.id == FamilyTree.user_id)
        .where(TreeShare.user_id == user.id, FamilyTree.is_deleted.is_(False))
        .order_by(FamilyTree.created_at.desc())
    ).all()
    result += [_tree_out(t, role, owner_username) for (t, role, owner_username) in shared]
    return result


@router.post("", response_model=TreeOut, status_code=status.HTTP_201_CREATED)
def create_tree(
    payload: TreeCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> TreeOut:
    tree = FamilyTree(user_id=user.id, name=payload.name, description=payload.description)
    db.add(tree)
    db.commit()
    db.refresh(tree)
    return _tree_out(tree, "owner", user.username)


@router.get("/{tree_id}", response_model=TreeOut)
def get_tree(
    tree: FamilyTree = Depends(get_accessible_tree),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> TreeOut:
    role = tree_role(db, tree, user) or "viewer"
    return _tree_out(tree, role, tree.user.username)


@router.put("/{tree_id}", response_model=TreeOut)
def update_tree(
    payload: TreeUpdate,
    tree: FamilyTree = Depends(get_owned_tree),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> TreeOut:
    if payload.name is not None:
        tree.name = payload.name
    if payload.description is not None:
        tree.description = payload.description
    db.commit()
    db.refresh(tree)
    return _tree_out(tree, "owner", user.username)


@router.delete("/{tree_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tree(tree: FamilyTree = Depends(get_owned_tree), db: Session = Depends(get_db)) -> None:
    # Soft-delete per the API contract.
    tree.is_deleted = True
    db.commit()


# ---------------------------------------------------------------------------
# Sharing (owner-only management)
# ---------------------------------------------------------------------------
@router.get("/{tree_id}/shares", response_model=list[ShareOut])
def list_shares(
    tree: FamilyTree = Depends(get_owned_tree), db: Session = Depends(get_db)
) -> list[ShareOut]:
    rows = db.execute(
        select(TreeShare, User.username)
        .join(User, User.id == TreeShare.user_id)
        .where(TreeShare.tree_id == tree.id)
        .order_by(User.username)
    ).all()
    return [ShareOut(user_id=s.user_id, username=username, role=s.role) for (s, username) in rows]


@router.put("/{tree_id}/shares", response_model=ShareOut)
def upsert_share(
    payload: ShareCreate,
    tree: FamilyTree = Depends(get_owned_tree),
    db: Session = Depends(get_db),
) -> ShareOut:
    """Grant or change a collaborator's access (owner only). Idempotent per user."""
    if payload.user_id == tree.user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The owner already has full access",
        )
    target = db.get(User, payload.user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    share = db.get(TreeShare, {"tree_id": tree.id, "user_id": payload.user_id})
    if share is None:
        share = TreeShare(tree_id=tree.id, user_id=payload.user_id, role=payload.role)
        db.add(share)
    else:
        share.role = payload.role
    db.commit()
    return ShareOut(user_id=target.id, username=target.username, role=payload.role)


@router.delete("/{tree_id}/shares/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_share(
    user_id: uuid.UUID,
    tree: FamilyTree = Depends(get_owned_tree),
    db: Session = Depends(get_db),
) -> None:
    share = db.get(TreeShare, {"tree_id": tree.id, "user_id": user_id})
    if share is not None:
        db.delete(share)
        db.commit()
