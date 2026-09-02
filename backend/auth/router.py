"""Authentication routes: register, login, refresh, logout, password change."""
import hashlib
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from sqlalchemy import delete, func, select, text
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
from models import RefreshSession, User
from schemas import (
    LoginRequest,
    PasswordChange,
    RegistrationStatus,
    TokenResponse,
    UserCreate,
    UserOut,
)

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE = "refresh_token"

# Simple in-memory login throttle. Failed attempts are counted under THREE
# keys, each with its own cap per window:
#   pair  (username, ip)  10  — the normal "stop guessing this account" limit
#   ip                    20  — one host spraying many usernames
#   user                 100  — a botnet spread across many IPs on one account
# The per-pair cap is the low one so an attacker can't lock the victim out of
# their own account from elsewhere: guessing from IP A doesn't count against
# the victim logging in from IP B until the (deliberately high) per-user cap.
# Per-process (resets on restart) — enough to stop online password guessing on
# a single-host personal deployment without a new dependency.
#
# The username is stored as a truncated SHA-256 of its lowercase form, not the
# raw string: the key is attacker-chosen input, and hashing keeps the dict's
# memory per entry fixed regardless of what was typed.
_FAILED_LOGINS: dict[str, list[float]] = {}
_THROTTLE_WINDOW = 300.0
_THROTTLE_CAPS = {"pair": 10, "ip": 20, "user": 100}
# Expired keys are swept once per window (time-based, not "past N keys"): the
# old count-based trigger let an attacker who kept the table just under the
# threshold hold every entry forever. Between sweeps the table is bounded by
# the request rate × the window.
_last_sweep = 0.0
# Bootstrap registration is serialized on this Postgres advisory-lock key so two
# concurrent first-registrations can't both slip past the "no accounts yet"
# check and each create an administrator.
_REGISTER_LOCK_KEY = 0x70726F67  # "prog"

# Verified against when the username doesn't exist, so a miss takes the same
# time as a wrong password (no username-enumeration timing oracle).
_TIMING_PAD_HASH = hash_password("timing-pad-not-a-real-password")


def _sweep_failed_logins(now: float) -> None:
    """Drop every key whose newest failure is outside the window. Timestamps
    are appended in order, so the last one is the newest."""
    for key in [
        k for k, ts in _FAILED_LOGINS.items() if not ts or now - ts[-1] >= _THROTTLE_WINDOW
    ]:
        del _FAILED_LOGINS[key]


def _throttled(key: str) -> bool:
    now = time.monotonic()
    attempts = [t for t in _FAILED_LOGINS.get(key, []) if now - t < _THROTTLE_WINDOW]
    if attempts:
        _FAILED_LOGINS[key] = attempts
    else:
        # Never store an empty list — checking a key must not insert it.
        _FAILED_LOGINS.pop(key, None)
    return len(attempts) >= _THROTTLE_CAPS[key.split(":", 1)[0]]


def _record_failure(key: str) -> None:
    global _last_sweep
    now = time.monotonic()
    if now - _last_sweep > _THROTTLE_WINDOW:
        _sweep_failed_logins(now)
        _last_sweep = now
    _FAILED_LOGINS.setdefault(key, []).append(now)


def _throttle_keys(username: str, request: Request) -> tuple[str, str, str]:
    """(pair, ip, user) keys for one login attempt."""
    user_hash = hashlib.sha256(username.strip().lower().encode("utf-8")).hexdigest()[:32]
    ip = request.client.host if request.client else "unknown"
    return f"pair:{user_hash}:{ip}", f"ip:{ip}", f"user:{user_hash}"


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


def _revoke_all_sessions(db: Session, user: User) -> None:
    """Invalidate every token the user holds: refresh tokens lose their session
    rows and the version bump kills outstanding ACCESS tokens too."""
    db.execute(delete(RefreshSession).where(RefreshSession.user_id == user.id))
    user.token_version += 1


def _issue_tokens(
    db: Session, response: Response, user: User, rotate_from: RefreshSession | None = None
) -> TokenResponse:
    """Mint an access token + a refresh cookie backed by a new session row.

    `rotate_from` is the session the caller presented (on /auth/refresh): its
    row is deleted in the same transaction the replacement is inserted, so at
    any moment exactly one refresh token per device is live. Commits."""
    subject = str(user.id)
    jti = secrets.token_hex(16)
    if rotate_from is not None:
        db.delete(rotate_from)
    db.add(
        RefreshSession(
            user_id=user.id,
            jti=jti,
            expires_at=datetime.now(timezone.utc)
            + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
        )
    )
    db.commit()
    # Refresh is sliding: each login/refresh issues a fresh cookie carrying the
    # user's current token_version, so a version bump revokes older tokens.
    _set_refresh_cookie(response, create_refresh_token(subject, user.token_version, jti))
    return TokenResponse(
        access_token=create_access_token(subject, user.token_version),
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
    #
    # When the deployment sets BOOTSTRAP_TOKEN, that first registration also
    # needs it — otherwise whoever reaches a freshly deployed server first
    # becomes its administrator. Constant-time compare: the token is a secret.
    if settings.BOOTSTRAP_TOKEN:
        presented = payload.bootstrap_token or ""
        if not secrets.compare_digest(
            presented.encode("utf-8"), settings.BOOTSTRAP_TOKEN.encode("utf-8")
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="A valid bootstrap token is required to create the first account",
            )
    # Serialize concurrent bootstrap registrations (see _REGISTER_LOCK_KEY): the
    # xact lock is held until this transaction commits/rolls back, so the count
    # check and insert are atomic against a second concurrent registration.
    db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _REGISTER_LOCK_KEY})
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
def login(
    payload: LoginRequest,
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
) -> TokenResponse:
    pair_key, ip_key, user_key = _throttle_keys(payload.username, request)
    if _throttled(pair_key) or _throttled(ip_key) or _throttled(user_key):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed attempts — try again in a few minutes",
        )
    user = db.scalar(select(User).where(User.username == payload.username))
    # Always verify against SOME hash so unknown usernames take the same time.
    hashed = user.password_hash if user is not None else _TIMING_PAD_HASH
    if not verify_password(payload.password, hashed) or user is None:
        for key in (pair_key, ip_key, user_key):
            _record_failure(key)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password"
        )
    # A successful login proves this is the account holder: clear the account
    # keys. The per-IP count is deliberately left alone — one valid credential
    # must not reset a host's budget for guessing at everyone else.
    _FAILED_LOGINS.pop(pair_key, None)
    _FAILED_LOGINS.pop(user_key, None)
    # Opportunistic housekeeping: expired session rows (devices that never
    # refreshed again) are useless, so drop them on the write path we already
    # own instead of needing a scheduler.
    db.execute(delete(RefreshSession).where(RefreshSession.expires_at < datetime.now(timezone.utc)))
    return _issue_tokens(db, response, user)


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
    subject, version, jti = decoded
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
    session = db.scalar(select(RefreshSession).where(RefreshSession.jti == jti))
    if session is None or session.user_id != user.id:
        # The signature checks out and the version is current, but the session
        # row is gone: this token was already rotated away. The only way it is
        # being presented now is a replay — either the cookie was stolen and
        # the thief refreshed first (so the legitimate client is presenting the
        # stale one), or the thief is replaying after the legitimate client
        # moved on. Either way the honest party can't be told apart from the
        # attacker, so every session is revoked and both must log in again.
        # (The frontend single-flights its refresh call, so two of its own
        # tabs never race each other into this path.)
        _revoke_all_sessions(db, user)
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token reuse detected — all sessions revoked",
        )
    return _issue_tokens(db, response, user, rotate_from=session)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    response: Response,
    refresh_token: str | None = Cookie(default=None, alias=REFRESH_COOKIE),
    db: Session = Depends(get_db),
) -> Response:
    # Retire the server-side session so the cookie is dead even if a copy of it
    # survives somewhere (browser sync, a backup). A cookie that doesn't decode
    # has nothing to retire — clearing it is still the right response.
    if refresh_token is not None:
        decoded = decode_refresh_token(refresh_token)
        if decoded is not None:
            db.execute(delete(RefreshSession).where(RefreshSession.jti == decoded[2]))
            db.commit()
    response.delete_cookie(REFRESH_COOKIE, path="/auth")
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.post("/password", response_model=TokenResponse)
def change_password(
    payload: PasswordChange,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TokenResponse:
    """Self-service password change. Proving the current password is what
    stops a hijacked session (stolen access token) from locking the real owner
    out. Every other session is revoked; the caller gets a fresh token pair so
    THIS session stays signed in."""
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect"
        )
    user.password_hash = hash_password(payload.new_password)
    _revoke_all_sessions(db, user)
    db.commit()
    return _issue_tokens(db, response, user)
