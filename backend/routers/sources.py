"""Sources and per-individual citations.

The tables have existed since Phase 1 (populated by GEDCOM import), but until
now there was no way to see or edit them in the app. Sources belong to a tree;
a citation links an individual to a source with an optional page/notes.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth.deps import get_accessible_tree, get_editable_tree
from database import get_db
from models import Citation, FamilyTree, Individual, Source
from schemas import CitationCreate, CitationOut, SourceCreate, SourceOut, SourceUpdate

router = APIRouter(prefix="/api/trees/{tree_id}", tags=["sources"])


def _get_source(db: Session, tree: FamilyTree, source_id: uuid.UUID) -> Source:
    src = db.get(Source, source_id)
    if src is None or src.tree_id != tree.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source not found")
    return src


def _get_individual(db: Session, tree: FamilyTree, individual_id: uuid.UUID) -> Individual:
    indi = db.get(Individual, individual_id)
    if indi is None or indi.tree_id != tree.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Individual not found")
    return indi


# ----- Sources --------------------------------------------------------------
@router.get("/sources", response_model=list[SourceOut])
def list_sources(
    tree: FamilyTree = Depends(get_accessible_tree), db: Session = Depends(get_db)
) -> list[Source]:
    return list(
        db.scalars(select(Source).where(Source.tree_id == tree.id).order_by(Source.title))
    )


@router.post("/sources", response_model=SourceOut, status_code=status.HTTP_201_CREATED)
def create_source(
    payload: SourceCreate,
    tree: FamilyTree = Depends(get_editable_tree),
    db: Session = Depends(get_db),
) -> Source:
    src = Source(tree_id=tree.id, **payload.model_dump())
    db.add(src)
    db.commit()
    db.refresh(src)
    return src


@router.put("/sources/{source_id}", response_model=SourceOut)
def update_source(
    source_id: uuid.UUID,
    payload: SourceUpdate,
    tree: FamilyTree = Depends(get_editable_tree),
    db: Session = Depends(get_db),
) -> Source:
    src = _get_source(db, tree, source_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(src, field, value)
    db.commit()
    db.refresh(src)
    return src


@router.delete("/sources/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_source(
    source_id: uuid.UUID,
    tree: FamilyTree = Depends(get_editable_tree),
    db: Session = Depends(get_db),
) -> None:
    src = _get_source(db, tree, source_id)
    db.delete(src)  # citations cascade
    db.commit()


# ----- Citations ------------------------------------------------------------
def _citation_out(cit: Citation, title: str | None) -> CitationOut:
    return CitationOut(
        id=cit.id,
        source_id=cit.source_id,
        individual_id=cit.individual_id,
        page=cit.page,
        notes=cit.notes,
        source_title=title,
    )


@router.get("/individuals/{individual_id}/citations", response_model=list[CitationOut])
def list_citations(
    individual_id: uuid.UUID,
    tree: FamilyTree = Depends(get_accessible_tree),
    db: Session = Depends(get_db),
) -> list[CitationOut]:
    indi = _get_individual(db, tree, individual_id)
    rows = db.execute(
        select(Citation, Source.title)
        .join(Source, Source.id == Citation.source_id)
        .where(Citation.individual_id == indi.id)
        .order_by(Source.title)
    ).all()
    return [_citation_out(cit, title) for (cit, title) in rows]


@router.post(
    "/individuals/{individual_id}/citations",
    response_model=CitationOut,
    status_code=status.HTTP_201_CREATED,
)
def create_citation(
    individual_id: uuid.UUID,
    payload: CitationCreate,
    tree: FamilyTree = Depends(get_editable_tree),
    db: Session = Depends(get_db),
) -> CitationOut:
    indi = _get_individual(db, tree, individual_id)
    src = _get_source(db, tree, payload.source_id)
    cit = Citation(
        source_id=src.id, individual_id=indi.id, page=payload.page, notes=payload.notes
    )
    db.add(cit)
    db.commit()
    db.refresh(cit)
    return _citation_out(cit, src.title)


@router.delete("/citations/{citation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_citation(
    citation_id: uuid.UUID,
    tree: FamilyTree = Depends(get_editable_tree),
    db: Session = Depends(get_db),
) -> None:
    cit = db.get(Citation, citation_id)
    if cit is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Citation not found")
    # Tree scoping: the citation's individual must belong to this tree.
    indi = db.get(Individual, cit.individual_id)
    if indi is None or indi.tree_id != tree.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Citation not found")
    db.delete(cit)
    db.commit()
