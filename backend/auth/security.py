"""Password hashing (bcrypt) and JWT token creation/validation."""
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext

from config import settings

pwd_context = CryptContext(
    schemes=["bcrypt"],
    deprecated="auto",
    bcrypt__rounds=settings.BCRYPT_ROUNDS,
)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(subject: str, version: int = 0) -> str:
    """Create a short-lived access token. `subject` is the user id (string).

    `version` is the user's token_version — embedding it lets us invalidate
    already-issued ACCESS tokens (not just refresh tokens) the moment that
    column is bumped, e.g. on a password reset."""
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": subject, "type": "access", "ver": version, "exp": expire}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_refresh_token(subject: str, version: int = 0) -> str:
    """Create a long-lived refresh token stored in an httpOnly cookie.

    `version` is the user's token_version — bumping that column (password
    reset) makes every previously issued refresh token invalid."""
    expire = datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    payload = {"sub": subject, "type": "refresh", "ver": version, "exp": expire}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_access_token(token: str) -> tuple[str, int] | None:
    """Decode an access token. Returns (subject, version) or None.

    The version is checked against the user's current token_version by the
    caller so a bumped column invalidates already-issued access tokens."""
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except jwt.PyJWTError:
        return None
    if payload.get("type") != "access":
        return None
    sub = payload.get("sub")
    if not sub:
        return None
    try:
        return sub, int(payload.get("ver", 0))
    except (TypeError, ValueError):
        return None


def decode_refresh_token(token: str) -> tuple[str, int] | None:
    """Decode a refresh token. Returns (subject, version) or None."""
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except jwt.PyJWTError:
        return None
    if payload.get("type") != "refresh":
        return None
    sub = payload.get("sub")
    if not sub:
        return None
    try:
        return sub, int(payload.get("ver", 0))
    except (TypeError, ValueError):
        return None
