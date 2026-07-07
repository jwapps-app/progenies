"""GEDCOM import/export routes."""
import hashlib

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth.deps import get_accessible_tree, get_editable_tree
from database import get_db
from models import FamilyTree, GedcomFile
from schemas import ImportSummary
from services.gedcom_export import export_gedcom
from services.gedcom_import import import_gedcom

router = APIRouter(prefix="/api/trees/{tree_id}", tags=["gedcom"])

# Uploads are read fully into memory and archived in the database, so cap them.
MAX_IMPORT_BYTES = 25 * 1024 * 1024


@router.post("/import", response_model=ImportSummary)
async def import_tree(
    file: UploadFile = File(...),
    force: bool = False,
    tree: FamilyTree = Depends(get_editable_tree),
    db: Session = Depends(get_db),
) -> ImportSummary:
    raw = await file.read()
    if len(raw) > MAX_IMPORT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File is larger than {MAX_IMPORT_BYTES // (1024 * 1024)} MB",
        )
    try:
        content = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        content = raw.decode("latin-1")  # GEDCOM 5.5 ANSEL fallback (best effort)
    if "0 HEAD" not in content and "INDI" not in content:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File does not appear to be a valid GEDCOM document",
        )
    # Re-importing the same file silently doubles every person and family (an
    # easy accidental double-tap). The archive already records each import's
    # hash — reject an exact repeat unless the caller explicitly forces it.
    file_hash = hashlib.sha256(content.encode("utf-8", "replace")).hexdigest()
    if not force:
        already = db.scalar(
            select(GedcomFile.id).where(
                GedcomFile.tree_id == tree.id,
                GedcomFile.direction == "import",
                GedcomFile.file_hash == file_hash,
            )
        )
        if already is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "This exact file was already imported into this tree — importing it "
                    "again would duplicate every person. Add ?force=true to import anyway."
                ),
            )
    # The parse + thousands of inserts are synchronous; run them off the event
    # loop so a large import doesn't stall every other request.
    return await run_in_threadpool(import_gedcom, db, tree, content, file.filename)


@router.get("/export")
def export_tree(
    tree: FamilyTree = Depends(get_accessible_tree), db: Session = Depends(get_db)
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
