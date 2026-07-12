"""FastAPI dependencies for authentication and resource ownership."""
import uuid

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from auth.security import decode_access_token
from database import get_db
from models import FamilyTree, TreeShare, User

bearer_scheme = HTTPBearer(auto_error=False)


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    """Resolve the authenticated user from the Bearer access token."""
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    decoded = decode_access_token(credentials.credentials)
    if decoded is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    subject, version = decoded
    try:
        user_id = uuid.UUID(subject)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token subject")

    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    # A bumped token_version (password reset) invalidates already-issued access
    # tokens, not just refresh tokens.
    if version != user.token_version:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has been revoked",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


def tree_role(db: Session, tree: FamilyTree, user: User) -> str | None:
    """The user's access to a tree: 'owner', 'editor', 'viewer', or None."""
    if tree.user_id == user.id:
        return "owner"
    share = db.get(TreeShare, {"tree_id": tree.id, "user_id": user.id})
    return share.role if share is not None else None


def _load_tree(db: Session, tree_id: uuid.UUID) -> FamilyTree:
    tree = db.get(FamilyTree, tree_id)
    if tree is None or tree.is_deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tree not found")
    return tree


def get_owned_tree(
    tree_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FamilyTree:
    """Fetch a tree the current user owns, or raise 404. Owner-only actions
    (rename, delete, manage sharing) depend on this."""
    tree = _load_tree(db, tree_id)
    if tree.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tree not found")
    return tree


def get_accessible_tree(
    tree_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FamilyTree:
    """Fetch a tree the user can read — as owner or via any share. Read routes
    depend on this. Raises 404 when there's no access (don't reveal existence)."""
    tree = _load_tree(db, tree_id)
    if tree_role(db, tree, user) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tree not found")
    return tree


def get_editable_tree(
    tree_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FamilyTree:
    """Fetch a tree the user can modify — as owner or an 'editor' collaborator.
    Mutating routes depend on this. A read-only ('viewer') collaborator gets
    403; a non-collaborator gets 404 (existence stays hidden)."""
    tree = _load_tree(db, tree_id)
    role = tree_role(db, tree, user)
    if role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tree not found")
    if role not in ("owner", "editor"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Read-only access to this tree"
        )
    return tree


def get_admin_user(user: User = Depends(get_current_user)) -> User:
    """Require the authenticated user to be an administrator."""
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Administrator access required"
        )
    return user
