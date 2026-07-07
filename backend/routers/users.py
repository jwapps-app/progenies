"""Administrator user management.

Open registration only bootstraps the first (admin) account; every further
account is created here by an administrator. Admins can also reset passwords
and delete accounts (never their own — so an instance can't lock itself out).
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth.deps import get_admin_user, get_current_user
from auth.security import hash_password
from database import get_db
from models import User
from schemas import PasswordReset, UserCreate, UserDirectoryOut, UserOut

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("/directory", response_model=list[UserDirectoryOut])
def user_directory(
    user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[User]:
    """Every other account's id + username, for the tree-sharing picker. Any
    authenticated user may read this (it exposes no admin flags or timestamps)."""
    return list(
        db.scalars(select(User).where(User.id != user.id).order_by(User.username))
    )


def _require_user(db: Session, user_id: uuid.UUID) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


@router.get("", response_model=list[UserOut])
def list_users(
    _admin: User = Depends(get_admin_user), db: Session = Depends(get_db)
) -> list[User]:
    return list(db.scalars(select(User).order_by(User.created_at)))


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreate,
    _admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
) -> User:
    existing = db.scalar(select(User).where(User.username == payload.username))
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already taken")
    user = User(username=payload.username, password_hash=hash_password(payload.password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        # Concurrent create with the same username slipped past the check.
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already taken")
    db.refresh(user)
    return user


@router.post("/{user_id}/password", status_code=status.HTTP_204_NO_CONTENT)
def reset_password(
    user_id: uuid.UUID,
    payload: PasswordReset,
    _admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
) -> None:
    user = _require_user(db, user_id)
    user.password_hash = hash_password(payload.password)
    # Revoke every outstanding refresh token — a reset must end old sessions.
    user.token_version += 1
    db.commit()


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: uuid.UUID,
    admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
) -> None:
    if user_id == admin.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot delete your own account",
        )
    user = _require_user(db, user_id)
    # Their trees (and everything under them) cascade via the FK.
    db.delete(user)
    db.commit()
