"""Public read-only access to a tree via its share-link token.

No authentication: possession of the (unguessable, revocable) token grants
read-only access to that ONE tree — the "send the family tree to a relative"
path, without the admin having to create them an account. Strictly read-only:
only the data the chart and panel need, no mutation routes, no photos beyond
what the chart shows, no export.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from database import get_db
from models import Family, FamilyTree, Individual
from routers.visualization import build_ancestors, build_descendants
from schemas import DescendantNode, FamilyOut, IndividualOut, TreeNode

router = APIRouter(prefix="/public/{token}", tags=["public"])


class PublicTreeOut(BaseModel):
    name: str
    description: str | None = None


def get_shared_tree(token: str, db: Session = Depends(get_db)) -> FamilyTree:
    tree = db.scalar(select(FamilyTree).where(FamilyTree.share_token == token))
    if tree is None or tree.is_deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Link not found or revoked")
    return tree


@router.get("/tree", response_model=PublicTreeOut)
def public_tree(tree: FamilyTree = Depends(get_shared_tree)) -> PublicTreeOut:
    return PublicTreeOut(name=tree.name, description=tree.description)


@router.get("/individuals", response_model=list[IndividualOut])
def public_individuals(
    tree: FamilyTree = Depends(get_shared_tree), db: Session = Depends(get_db)
) -> list[IndividualOut]:
    people = db.scalars(
        select(Individual)
        .where(Individual.tree_id == tree.id)
        .order_by(Individual.surname, Individual.given_name)
    )
    out = []
    for p in people:
        dto = IndividualOut.model_validate(p)
        dto.photo_url = None  # keep the public list payload small
        out.append(dto)
    return out


@router.get("/families", response_model=list[FamilyOut])
def public_families(
    tree: FamilyTree = Depends(get_shared_tree), db: Session = Depends(get_db)
) -> list[Family]:
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
