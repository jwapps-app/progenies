"""Test fixtures: a TestClient against a DISPOSABLE Postgres database.

DATABASE_URL must be set explicitly and must contain "test" in the database
name — every session DROPS ALL TABLES before starting, so pointing it at a
real database would destroy it. CI provides a fresh postgres service; locally:

    DATABASE_URL=postgresql://kindred:kindred@localhost:5432/genealogy_test \
        python -m pytest tests/
"""
import os

# Must be set before config/app import (pydantic reads env at import time).
os.environ.setdefault("SECRET_KEY", "test-secret-key-not-for-production")
os.environ.setdefault("BCRYPT_ROUNDS", "4")  # fast hashing for tests

_db_url = os.environ.get("DATABASE_URL", "")
if "test" not in _db_url.rsplit("/", 1)[-1]:
    raise RuntimeError(
        "Refusing to run: DATABASE_URL must point at a disposable database whose "
        f"name contains 'test' (got {_db_url!r}). The suite drops all tables."
    )

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="session")
def client():
    import models  # noqa: F401 — register every table on Base before drop/create
    from database import Base, engine

    Base.metadata.drop_all(bind=engine)
    from main import app

    # Entering the context runs the startup hook (create_all + migrations).
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def admin(client):
    """Bootstrap the first (admin) account and return its auth headers."""
    r = client.post("/auth/register", json={"username": "admin", "password": "password123"})
    assert r.status_code == 201, r.text
    r = client.post("/auth/login", json={"username": "admin", "password": "password123"})
    assert r.status_code == 200, r.text
    tok = r.json()["access_token"]
    return {"Authorization": f"Bearer {tok}"}
