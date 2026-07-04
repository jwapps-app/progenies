"""Genealogy PWA — FastAPI application entrypoint."""
import time

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.exc import OperationalError

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
from routers.warnings import router as warnings_router

# Ensure all models are imported so create_all sees them.
import models  # noqa: F401, E402

app = FastAPI(title=settings.APP_NAME, version="1.0.0", description="Genealogy & Family Tree PWA")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_origin_regex=settings.CORS_ORIGIN_REGEX or None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    """UPDATE users SET is_admin = TRUE
       WHERE id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1)
         AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin)""",
)


@app.on_event("startup")
def on_startup() -> None:
    """Wait for the database, create tables, and apply additive migrations."""
    last_error: Exception | None = None
    for _ in range(30):
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            Base.metadata.create_all(bind=engine)
            with engine.begin() as conn:
                for stmt in _LIGHTWEIGHT_MIGRATIONS:
                    conn.execute(text(stmt))
            return
        except OperationalError as exc:  # database not ready yet
            last_error = exc
            time.sleep(1)
    if last_error is not None:
        raise last_error


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
app.include_router(users_router)
