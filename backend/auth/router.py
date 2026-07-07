"""Authentication routes: register, login, refresh."""
import time
import uuid

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from auth.deps import get_current_user
from auth.security import (
    create_access_token,
    create_refresh_token,
    decode_refresh_token,
    hash_password,
    verify_password,
)
from config import settings
from database import get_db
from models import User
from schemas import LoginRequest, RegistrationStatus, TokenResponse, UserCreate, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE = "refresh_token"

# Simple in-memory login throttle: after MAX failed attempts for a username
# within the window, further attempts 429 until it rolls. Per-process (resets
# on restart) — enough to stop online password guessing on a single-host
# personal deployment without a new dependency.
_FAILED_LOGINS: dict[str, list[float]] = {}
_THROTTLE_WINDOW = 300.0
_THROTTLE_MAX_FAILURES = 10

# Verified against when the username doesn't exist, so a miss takes the same
# time as a wrong password (no username-enumeration timing oracle).
_TIMING_PAD_HASH = hash_password("timing-pad-not-a-real-password")


def _throttled(key: str) -> bool:
    now = time.monotonic()
    attempts = [t for t in _FAILED_LOGINS.get(key, []) if now - t < _THROTTLE_WINDOW]
    _FAILED_LOGINS[key] = attempts
    return len(attempts) >= _THROTTLE_MAX_FAILURES


def _record_failure(key: str) -> None:
    _FAILED_LOGINS.setdefault(key, []).append(time.monotonic())


def _set_refresh_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=REFRESH_COOKIE,
        value=token,
        httponly=True,
        samesite="lax",
        # TRUE in production (HTTPS via the Cloudflare Tunnel); dev opts out.
        secure=settings.COOKIE_SECURE,
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 3600,
        path="/auth",
    )


def _issue_tokens(response: Response, user: User) -> TokenResponse:
    subject = str(user.id)
    # Refresh is sliding: each login/refresh issues a fresh cookie carrying the
    # user's current token_version, so a version bump revokes older tokens.
    _set_refresh_cookie(response, create_refresh_token(subject, user.token_version))
    return TokenResponse(
        access_token=create_access_token(subject),
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        username=user.username,
        is_admin=user.is_admin,
    )


@router.get("/registration", response_model=RegistrationStatus)
def registration_status(db: Session = Depends(get_db)) -> RegistrationStatus:
    """Public: whether open registration is available (only before any account
    exists — the first registration creates the administrator)."""
    return RegistrationStatus(open=db.scalar(select(func.count(User.id))) == 0)


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def register(payload: UserCreate, db: Session = Depends(get_db)) -> User:
    # Open registration is a bootstrap-only path: it creates the FIRST account
    # (the administrator) and then closes. Further accounts are created by the
    # admin via /api/users.
    if db.scalar(select(func.count(User.id))) > 0:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Registration is closed — ask the administrator for an account",
        )
    user = User(
        username=payload.username,
        password_hash=hash_password(payload.password),
        is_admin=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)) -> User:
    return user


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, response: Response, db: Session = Depends(get_db)) -> TokenResponse:
    throttle_key = payload.username.strip().lower()
    if _throttled(throttle_key):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed attempts — try again in a few minutes",
        )
    user = db.scalar(select(User).where(User.username == payload.username))
    # Always verify against SOME hash so unknown usernames take the same time.
    hashed = user.password_hash if user is not None else _TIMING_PAD_HASH
    if not verify_password(payload.password, hashed) or user is None:
        _record_failure(throttle_key)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password"
        )
    _FAILED_LOGINS.pop(throttle_key, None)
    return _issue_tokens(response, user)


@router.post("/refresh", response_model=TokenResponse)
def refresh(
    response: Response,
    refresh_token: str | None = Cookie(default=None, alias=REFRESH_COOKIE),
    db: Session = Depends(get_db),
) -> TokenResponse:
    if refresh_token is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing refresh token")
    decoded = decode_refresh_token(refresh_token)
    if decoded is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    subject, version = decoded
    try:
        user_id = uuid.UUID(subject)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    if version != user.token_version:
        # Token predates a password reset — revoked.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session revoked")
    return _issue_tokens(response, user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(response: Response) -> Response:
    response.delete_cookie(REFRESH_COOKIE, path="/auth")
    response.status_code = status.HTTP_204_NO_CONTENT
    return response
