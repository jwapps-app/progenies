"""Password hashing (bcrypt) and JWT token creation/validation."""
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from config import settings

# The `bcrypt` package is used directly rather than through passlib: passlib
# 1.7.4 is unmaintained and breaks against bcrypt 5.x (it probes the backend
# with a >72-byte password, which bcrypt 5 now rejects instead of truncating).
# The output format is identical ("$2b$<rounds>$<salt+digest>"), so every hash
# passlib wrote remains valid and verifies unchanged.

# Only the standard claims every token carries are required; a token missing
# any of them is malformed and rejected outright rather than defaulted.
_REQUIRED_CLAIMS = ["exp", "sub", "type"]


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(settings.BCRYPT_ROUNDS)).decode("ascii")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        # A malformed stored hash (bcrypt raises "Invalid salt") is a failed
        # verification, not a server error — never let it turn into a 500.
        return False


def _encode(payload: dict) -> str:
    # `iat` lets a future "reject tokens issued before X" check work, and PyJWT
    # rejects a token whose iat lies in the future (clock-skew or forgery).
    payload = {"iat": datetime.now(timezone.utc), **payload}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def _decode(token: str) -> dict | None:
    try:
        return jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
            options={"require": _REQUIRED_CLAIMS},
        )
    except jwt.PyJWTError:
        return None


def create_access_token(subject: str, version: int = 0) -> str:
    """Create a short-lived access token. `subject` is the user id (string).

    `version` is the user's token_version — embedding it lets us invalidate
    already-issued ACCESS tokens (not just refresh tokens) the moment that
    column is bumped, e.g. on a password reset."""
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    return _encode({"sub": subject, "type": "access", "ver": version, "exp": expire})


def create_refresh_token(subject: str, version: int, jti: str) -> str:
    """Create a long-lived refresh token stored in an httpOnly cookie.

    `version` is the user's token_version — bumping that column (password
    reset) makes every previously issued refresh token invalid. `jti` is the
    unique id of this token's server-side session row: a refresh token is only
    honoured while its row exists, which is what makes rotation (and reuse
    detection of an already-rotated token) possible."""
    expire = datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    return _encode({"sub": subject, "type": "refresh", "ver": version, "jti": jti, "exp": expire})


def _subject_and_version(payload: dict) -> tuple[str, int] | None:
    sub = payload.get("sub")
    if not sub or not isinstance(sub, str):
        return None
    try:
        return sub, int(payload.get("ver", 0))
    except (TypeError, ValueError):
        return None


def decode_access_token(token: str) -> tuple[str, int] | None:
    """Decode an access token. Returns (subject, version) or None.

    The version is checked against the user's current token_version by the
    caller so a bumped column invalidates already-issued access tokens."""
    payload = _decode(token)
    if payload is None or payload.get("type") != "access":
        return None
    return _subject_and_version(payload)


def decode_refresh_token(token: str) -> tuple[str, int, str] | None:
    """Decode a refresh token. Returns (subject, version, jti) or None.

    A refresh token without a `jti` (issued before session tracking existed)
    can't be matched to a session row, so it is simply invalid — the user logs
    in once more and gets a tracked one."""
    payload = _decode(token)
    if payload is None or payload.get("type") != "refresh":
        return None
    base = _subject_and_version(payload)
    jti = payload.get("jti")
    if base is None or not jti or not isinstance(jti, str):
        return None
    return base[0], base[1], jti
