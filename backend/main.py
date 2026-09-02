"""Genealogy PWA — FastAPI application entrypoint."""
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select, text
from sqlalchemy.exc import OperationalError, ProgrammingError

from auth.router import router as auth_router
from config import settings
from database import Base, engine
from routers.duplicates import router as duplicates_router
from routers.families import router as families_router
from routers.gedcom import router as gedcom_router
from routers.users import router as users_router
from routers.individuals import router as individuals_router
from routers.trees import router as trees_router
from routers.visualization import router as visualization_router
from routers.public import router as public_router
from routers.sources import router as sources_router
from routers.warnings import router as warnings_router

# Ensure all models are imported so create_all sees them.
import models  # noqa: F401, E402
from models import User  # noqa: E402

# Startup messages go through uvicorn's own logger so they land in the same
# stream (and format) as its "Application startup complete" line — a plain
# module logger has no handler configured under uvicorn.
_log = logging.getLogger("uvicorn.error")

# Idempotent additive migrations applied at startup (pre-Alembic). create_all
# only creates missing tables, so new columns on existing tables are added here.
# Each statement must be safe to run repeatedly (IF NOT EXISTS).
_LIGHTWEIGHT_MIGRATIONS = (
    "ALTER TABLE individuals ADD COLUMN IF NOT EXISTS middle_name TEXT",
    "ALTER TABLE individuals ADD COLUMN IF NOT EXISTS age TEXT",
    "ALTER TABLE families ADD COLUMN IF NOT EXISTS marriage_order INTEGER",
    "ALTER TABLE families ADD COLUMN IF NOT EXISTS gap BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE families ADD COLUMN IF NOT EXISTS unmarried BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE children ADD COLUMN IF NOT EXISTS relation TEXT NOT NULL DEFAULT 'biological'",
    "ALTER TABLE individuals ADD COLUMN IF NOT EXISTS photo_url TEXT",
    "ALTER TABLE individuals ADD COLUMN IF NOT EXISTS married_name TEXT",
    "ALTER TABLE individuals ADD COLUMN IF NOT EXISTS nickname TEXT",
    # Spouse lookups (visualization, merge) filter families by husband/wife —
    # without these every such query is a sequential scan of all families.
    "CREATE INDEX IF NOT EXISTS ix_families_husband_id ON families (husband_id)",
    "CREATE INDEX IF NOT EXISTS ix_families_wife_id ON families (wife_id)",
    # Child->family lookups (ancestor CTE walks child rows by individual).
    "CREATE INDEX IF NOT EXISTS ix_children_individual_id ON children (individual_id)",
    # First-account-is-admin: add the flag, and on existing installs promote the
    # earliest account if no admin exists yet (safe to run repeatedly).
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE",
    # Public read-only share links.
    "ALTER TABLE family_trees ADD COLUMN IF NOT EXISTS share_token TEXT",
    "CREATE UNIQUE INDEX IF NOT EXISTS ix_family_trees_share_token ON family_trees (share_token)",
    # Refresh-token revocation (bumped on password reset).
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0",
    # Citation lookups (merge re-pointing, cascade deletes) filter by these FKs.
    "CREATE INDEX IF NOT EXISTS ix_citations_individual_id ON citations (individual_id)",
    "CREATE INDEX IF NOT EXISTS ix_citations_source_id ON citations (source_id)",
    # gedcom_xref is never looked up on its own (every query filters by tree_id
    # first), so these standalone indexes — created by an earlier index=True on
    # the models — only cost write time. Names verified against what SQLAlchemy
    # generated for those columns.
    "DROP INDEX IF EXISTS ix_individuals_gedcom_xref",
    "DROP INDEX IF EXISTS ix_families_gedcom_xref",
    "DROP INDEX IF EXISTS ix_sources_gedcom_xref",
    """UPDATE users SET is_admin = TRUE
       WHERE id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1)
         AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin)""",
)

# The production image runs two uvicorn workers, each of which executes this
# startup. Schema creation is serialized on a session-level Postgres advisory
# lock so the second worker waits for the first instead of racing it into
# "relation already exists" errors.
_STARTUP_LOCK_KEY = 0x70726F68  # "proh"

_PLACEHOLDER_SECRET = "change-me-in-production"
# HS256 is keyed on this string directly; a key shorter than the HMAC output
# (32 bytes) is the weak point of the whole token scheme.
_MIN_SECRET_BYTES = 32


def _check_secret_key(key: str) -> None:
    """Refuse to run with a placeholder or short signing key: JWTs signed with
    a publicly known (or guessable) key mean anyone can mint an admin token. A
    deploy that forgets the env var must fail loudly, not silently run
    insecure."""
    stripped = key.strip()
    if stripped == _PLACEHOLDER_SECRET:
        raise RuntimeError(
            "SECRET_KEY is not set (still the placeholder). Generate one with "
            "`openssl rand -hex 32` and set it in the environment."
        )
    if len(stripped.encode("utf-8")) < _MIN_SECRET_BYTES:
        raise RuntimeError(
            f"SECRET_KEY is too short ({len(stripped.encode('utf-8'))} bytes; need at "
            f"least {_MIN_SECRET_BYTES}). Generate one with `openssl rand -hex 32`."
        )


def _apply_schema() -> None:
    """create_all + migrations under the startup advisory lock, on ONE
    connection (a session-level lock belongs to the connection that took it).
    The unlock is unconditional: a pooled connection that kept the lock would
    block the other worker's startup forever."""
    with engine.connect() as conn:
        conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": _STARTUP_LOCK_KEY})
        try:
            Base.metadata.create_all(bind=conn)
            for stmt in _LIGHTWEIGHT_MIGRATIONS:
                conn.execute(text(stmt))
            conn.commit()
        finally:
            # A failed DDL leaves the transaction aborted; roll it back (a no-op
            # after a successful commit) so the unlock itself can run.
            conn.rollback()
            conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _STARTUP_LOCK_KEY})
            conn.commit()


def _warn_if_bootstrap_open() -> None:
    """A server with no account yet accepts its first registration from anyone
    who can reach it — that first account is the administrator. Say so loudly
    unless BOOTSTRAP_TOKEN gates that path."""
    if settings.BOOTSTRAP_TOKEN:
        return
    with engine.connect() as conn:
        users = conn.scalar(select(func.count(User.id)))
    if users == 0:
        _log.warning(
            "No user accounts exist and BOOTSTRAP_TOKEN is not set: the first "
            "registration is open to anyone who can reach this server and will "
            "become the administrator. Set BOOTSTRAP_TOKEN to gate it."
        )


def _startup() -> None:
    """Wait for the database, create tables, and apply additive migrations."""
    _check_secret_key(settings.SECRET_KEY)
    last_error: Exception | None = None
    for _ in range(30):
        try:
            _apply_schema()
            break
        except OperationalError as exc:  # database not ready yet
            last_error = exc
            time.sleep(1)
        except ProgrammingError as exc:
            # "already exists" from an object the other worker created between
            # our check and our CREATE. The lock makes that a theoretical race
            # now, but a retry is harmless and the alternative is a dead worker.
            _log.warning("Schema step failed (%s); retrying", exc.orig or exc)
            last_error = exc
            time.sleep(1)
    else:
        if last_error is not None:
            raise last_error
    _warn_if_bootstrap_open()


@asynccontextmanager
async def _lifespan(app: FastAPI):
    _startup()
    yield


app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    description="Genealogy & Family Tree PWA",
    lifespan=_lifespan,
    # Schema + interactive docs are gated: exposed only where DOCS_ENABLED is set
    # (dev), disabled in production so the API surface isn't published.
    docs_url="/docs" if settings.DOCS_ENABLED else None,
    redoc_url="/redoc" if settings.DOCS_ENABLED else None,
    openapi_url="/openapi.json" if settings.DOCS_ENABLED else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_origin_regex=settings.CORS_ORIGIN_REGEX or None,
    allow_credentials=True,
    # Enumerate rather than "*": the app only ever issues these methods/headers,
    # and a credentialed CORS config should be as narrow as it can be.
    # X-Share-Token carries the public read-only link token (kept out of the
    # URL so it doesn't land in proxy/access logs and browser history).
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Share-Token"],
)


@app.get("/health", tags=["health"])
def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(auth_router)
app.include_router(trees_router)
app.include_router(individuals_router)
app.include_router(families_router)
app.include_router(gedcom_router)
app.include_router(visualization_router)
app.include_router(duplicates_router)
app.include_router(warnings_router)
app.include_router(sources_router)
app.include_router(public_router)
app.include_router(users_router)
