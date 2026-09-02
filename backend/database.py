"""Database engine, session management, and base declarative class."""
from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from config import settings

engine = create_engine(
    settings.DATABASE_URL,
    # Probe a pooled connection before handing it out, so a connection the
    # server dropped (Postgres restart, idle timeout) is replaced instead of
    # failing the first request that lands on it.
    pool_pre_ping=True,
    # Hard ceiling of 20 connections per process (10 resident + 10 overflow):
    # this is a single-uvicorn-worker deployment against a default Postgres
    # (max_connections=100), so the pool must never be the thing that exhausts
    # the server. Requests beyond the ceiling queue for a connection.
    pool_size=10,
    max_overflow=10,
    # Retire connections after 30 minutes so a long-lived pool doesn't hold
    # sockets across a server-side reconfiguration or a proxy's idle cutoff.
    pool_recycle=1800,
    future=True,
    # Server-side safety limits, set per session on connect:
    #   statement_timeout (30s) — caps any ONE statement. It is per statement,
    #     not per request/transaction, so the GEDCOM import's thousands of
    #     short inserts are unaffected; only a single pathological query (a
    #     runaway recursive CTE, a seq scan over a huge tree) is cut off. The
    #     unauthenticated public chart routes tighten this further with a
    #     SET LOCAL inside their own transaction (see routers/public.py).
    #   idle_in_transaction_session_timeout (60s) — kills a session that opened
    #     a transaction and then went quiet (a handler that raised between
    #     statements, a client that vanished mid-request), so it can't sit on
    #     row locks and a pooled connection indefinitely.
    #   lock_timeout (5s) — bounds how long a statement waits for a row/table
    #     lock, so two concurrent edits to the same family fail fast with a
    #     clear error rather than piling up behind each other.
    connect_args={
        "options": (
            "-c statement_timeout=30000"
            " -c idle_in_transaction_session_timeout=60000"
            " -c lock_timeout=5000"
        )
    },
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency that yields a database session and always closes it."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
