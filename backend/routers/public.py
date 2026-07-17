"""Public read-only access to a tree via its share-link token.

No authentication: possession of the (unguessable, revocable) token grants
read-only access to that ONE tree — the "send the family tree to a relative"
path, without the admin having to create them an account. Strictly read-only:
only the data the chart and panel need, no mutation routes, no photos beyond
what the chart shows, no export.
"""
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from database import get_db
from models import Family, FamilyTree, Individual
from routers.visualization import build_ancestors, build_descendants
from schemas import (
    DescendantNode,
    PublicFamilyOut,
    PublicIndividualOut,
    TreeNode,
)

router = APIRouter(prefix="/public/{token}", tags=["public"])

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
    token: str, request: Request, db: Session = Depends(get_db)
) -> FamilyTree:
    _rate_limit(request)
    tree = db.scalar(select(FamilyTree).where(FamilyTree.share_token == token))
    if tree is None or tree.is_deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Link not found or revoked")
    return tree


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
    return build_descendants(db, tree, individual_id)


@router.get("/ancestors/{individual_id}", response_model=TreeNode)
def public_ancestors(
    individual_id: uuid.UUID,
    tree: FamilyTree = Depends(get_shared_tree),
    db: Session = Depends(get_db),
) -> TreeNode:
    return build_ancestors(db, tree, individual_id)
