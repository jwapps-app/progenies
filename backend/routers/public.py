"""Public read-only access to a tree via its share-link token.

No authentication: possession of the (unguessable, revocable) token grants
read-only access to that ONE tree — the "send the family tree to a relative"
path, without the admin having to create them an account. Strictly read-only:
only the data the chart and panel need, no mutation routes, no photos beyond
what the chart shows, no export.

The token travels in the X-Share-Token request header, never in the URL. A
path token (/public/{token}/...) was written into every access log between
the browser and the app — nginx, uvicorn, the Cloudflare tunnel — which is
exactly the kind of place a credential must not accumulate. The share URL the
owner hands out carries the token in the fragment (/share#token), which the
browser never sends to any server; the SPA lifts it out and sends it here as
a header.
"""
import time
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.orm import Session, selectinload

from database import get_db
from models import Family, FamilyTree, Individual
from routers.individuals import PhotoBatchRequest, photos_for
from routers.visualization import build_ancestors, build_descendants
from schemas import (
    DescendantNode,
    PublicFamilyOut,
    PublicIndividualOut,
    TreeNode,
)

router = APIRouter(prefix="/public", tags=["public"])

SHARE_TOKEN_HEADER = "X-Share-Token"

# Per-IP rate limit for the unauthenticated share surface. These routes run
# recursive tree traversals, so an open loop against them is the cheapest DoS.
# In-memory sliding window, per-process (resets on restart) — enough for a
# self-hosted single-host deployment without adding a dependency.
_PUBLIC_HITS: dict[str, list[float]] = {}
_RATE_WINDOW = 60.0
_RATE_MAX = 120  # requests per IP per window
# Opportunistic GC threshold: past this many keys, expired entries are swept.
# Without it, every IP ever seen keeps an entry forever — attacker-growable
# memory on an unauthenticated surface (rotate source IPs).
_RATE_SWEEP_AT = 1024

# The chart routes are the expensive ones on this unauthenticated surface, so
# they run under a tighter per-statement cap than the engine-wide default
# (30s, see database.py). SET LOCAL scopes it to the current transaction; the
# session's rollback-on-close discards it.
_PUBLIC_CHART_STATEMENT_TIMEOUT_MS = 10000


def _sweep_public_hits(now: float) -> None:
    """Drop every key whose newest hit is outside the window. Timestamps are
    appended in order, so the last one is the newest."""
    for key in [
        k for k, ts in _PUBLIC_HITS.items() if not ts or now - ts[-1] >= _RATE_WINDOW
    ]:
        del _PUBLIC_HITS[key]


def _rate_limit(request: Request) -> None:
    key = request.client.host if request.client else "unknown"
    now = time.monotonic()
    if len(_PUBLIC_HITS) >= _RATE_SWEEP_AT:
        _sweep_public_hits(now)
    hits = [t for t in _PUBLIC_HITS.get(key, []) if now - t < _RATE_WINDOW]
    if len(hits) >= _RATE_MAX:
        _PUBLIC_HITS[key] = hits
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many requests — slow down",
        )
    hits.append(now)
    _PUBLIC_HITS[key] = hits


class PublicTreeOut(BaseModel):
    name: str
    description: str | None = None


def get_shared_tree(
    request: Request,
    token: str | None = Header(default=None, alias=SHARE_TOKEN_HEADER),
    db: Session = Depends(get_db),
) -> FamilyTree:
    _rate_limit(request)
    if not token:
        # Distinct from the 404 below: the caller sent no credential at all
        # (an old path-style client, or a hand-typed URL), not a wrong one.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Share token required in the {SHARE_TOKEN_HEADER} header",
        )
    tree = db.scalar(select(FamilyTree).where(FamilyTree.share_token == token))
    if tree is None or tree.is_deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Link not found or revoked")
    return tree


def _tighten_statement_timeout(db: Session) -> None:
    """Cap each statement of the current transaction (the chart CTEs) below
    the engine-wide default. get_shared_tree already opened the transaction
    with its token lookup, so SET LOCAL lands inside it."""
    db.execute(text(f"SET LOCAL statement_timeout = {_PUBLIC_CHART_STATEMENT_TIMEOUT_MS}"))


@router.get("/tree", response_model=PublicTreeOut)
def public_tree(tree: FamilyTree = Depends(get_shared_tree)) -> PublicTreeOut:
    return PublicTreeOut(name=tree.name, description=tree.description)


@router.get("/individuals", response_model=list[PublicIndividualOut])
def public_individuals(
    tree: FamilyTree = Depends(get_shared_tree), db: Session = Depends(get_db)
) -> list[PublicIndividualOut]:
    # PublicIndividualOut deliberately drops notes, places, gedcom_xref,
    # photo_url, timestamps and tree_id — an unauthenticated caller sees only
    # what the read-only chart renders. SELECT exactly the DTO's columns so the
    # dropped blobs (free-text notes, base64 photos) never even cross the
    # database wire for this hot unauthenticated route.
    stmt = (
        select(*(getattr(Individual, name) for name in PublicIndividualOut.model_fields))
        .where(Individual.tree_id == tree.id)
        .order_by(Individual.surname, Individual.given_name)
    )
    return [PublicIndividualOut.model_validate(dict(row._mapping)) for row in db.execute(stmt)]


@router.get("/families", response_model=list[PublicFamilyOut])
def public_families(
    tree: FamilyTree = Depends(get_shared_tree), db: Session = Depends(get_db)
) -> list[Family]:
    # PublicFamilyOut drops married/divorced dates+places, notes and gedcom_xref.
    return list(
        db.scalars(
            select(Family)
            .where(Family.tree_id == tree.id)
            .options(selectinload(Family.children))
        )
    )


@router.get("/descendants/{individual_id}", response_model=DescendantNode)
def public_descendants(
    individual_id: uuid.UUID,
    tree: FamilyTree = Depends(get_shared_tree),
    db: Session = Depends(get_db),
) -> DescendantNode:
    _tighten_statement_timeout(db)
    return build_descendants(db, tree, individual_id)


@router.get("/ancestors/{individual_id}", response_model=TreeNode)
def public_ancestors(
    individual_id: uuid.UUID,
    tree: FamilyTree = Depends(get_shared_tree),
    db: Session = Depends(get_db),
) -> TreeNode:
    _tighten_statement_timeout(db)
    return build_ancestors(db, tree, individual_id)


@router.post("/photos", response_model=dict[str, str])
def public_photos(
    payload: PhotoBatchRequest,
    response: Response,
    tree: FamilyTree = Depends(get_shared_tree),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    """Photo thumbnails for the people on the shared chart, keyed by id. The
    chart payload no longer carries photos (see routers/visualization.py); the
    viewer fetches them here in one batch for just the ids it renders. Scoped
    to the shared tree — ids from any other tree are silently absent. The
    individuals list above stays photo-free."""
    response.headers["Cache-Control"] = "private, max-age=300"
    return photos_for(db, tree, payload.ids)
