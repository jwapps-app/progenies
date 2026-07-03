"""GEDCOM import/export routes."""
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import Response
from sqlalchemy.orm import Session

from auth.deps import get_owned_tree
from database import get_db
from models import FamilyTree
from schemas import ImportSummary
from services.gedcom_export import export_gedcom
from services.gedcom_import import import_gedcom

router = APIRouter(prefix="/api/trees/{tree_id}", tags=["gedcom"])


@router.post("/import", response_model=ImportSummary)
async def import_tree(
    file: UploadFile = File(...),
    tree: FamilyTree = Depends(get_owned_tree),
    db: Session = Depends(get_db),
) -> ImportSummary:
    raw = await file.read()
    try:
        content = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        content = raw.decode("latin-1")  # GEDCOM 5.5 ANSEL fallback (best effort)
    if "0 HEAD" not in content and "INDI" not in content:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File does not appear to be a valid GEDCOM document",
        )
    return import_gedcom(db, tree, content, file.filename)


@router.get("/export")
def export_tree(
    tree: FamilyTree = Depends(get_owned_tree), db: Session = Depends(get_db)
) -> Response:
    text = export_gedcom(db, tree)
    safe_name = "".join(c for c in tree.name if c.isalnum() or c in (" ", "_", "-")).strip() or "tree"
    # The document is already fully in memory — a plain Response sends it in one
    # write. (StreamingResponse over BytesIO chunked it through a thread executor,
    # adding ~0.8s for a 255KB export.)
    return Response(
        content=text.encode("utf-8"),
        media_type="application/x-gedcom",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.ged"'},
    )
