"""GEDCOM import/export routes."""
import hashlib
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth.deps import get_accessible_tree, get_current_user, get_editable_tree, tree_role
from database import get_db
from models import FamilyTree, GedcomFile, User
from schemas import ImportSummary
from services.gedcom_export import export_gedcom
from services.gedcom_import import import_gedcom

router = APIRouter(prefix="/api/trees/{tree_id}", tags=["gedcom"])

# Uploads are read fully into memory and archived in the database, so cap them.
MAX_IMPORT_BYTES = 25 * 1024 * 1024
# Multipart framing (boundary lines, part headers) around the file itself. The
# Content-Length check below compares the WHOLE body, so allow this much on top
# of the file cap rather than rejecting a file that is exactly at the limit.
_MULTIPART_OVERHEAD = 16 * 1024


def _guarded_import(
    db: Session,
    tree: FamilyTree,
    content: str,
    filename: str | None,
    file_hash: str,
    force: bool,
) -> ImportSummary:
    """Duplicate-hash check + import as ONE synchronous unit.

    Re-importing the same file silently doubles every person and family (an
    easy accidental double-tap). The archive already records each import's
    hash — reject an exact repeat unless the caller explicitly forces it.
    The hash lookup lives here, not in the async route, because it is a
    blocking database call (it would stall the event loop) — and running the
    check and the import in the same transaction narrows the window where two
    identical concurrent uploads both pass the check.
    """
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
    return import_gedcom(db, tree, content, filename, file_hash)


@router.post("/import", response_model=ImportSummary)
async def import_tree(
    request: Request,
    file: UploadFile = File(...),
    force: bool = False,
    tree: FamilyTree = Depends(get_editable_tree),
    db: Session = Depends(get_db),
) -> ImportSummary:
    too_large = HTTPException(
        status_code=status.HTTP_413_CONTENT_TOO_LARGE,
        detail=f"File is larger than {MAX_IMPORT_BYTES // (1024 * 1024)} MB",
    )
    # Cheap early rejections on the declared sizes. Note what these do NOT do:
    # by the time this route runs, Starlette has already parsed the multipart
    # body (spooling anything large to a temp file), so nothing here prevents
    # the bytes from arriving. The real pre-buffer cap is nginx's
    # client_max_body_size in front of the app; these checks just refuse to
    # pull an oversized upload into memory and through the parser.
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > MAX_IMPORT_BYTES + _MULTIPART_OVERHEAD:
        raise too_large
    if file.size is not None and file.size > MAX_IMPORT_BYTES:
        raise too_large
    raw = await file.read()
    if len(raw) > MAX_IMPORT_BYTES:  # backstop if the size wasn't known up front
        raise too_large
    # Hash the RAW bytes exactly once — the duplicate check and the archive row
    # both use this digest, so the two can never disagree (hashing a re-encoded
    # decode of the text, as before, could).
    file_hash = hashlib.sha256(raw).hexdigest()
    try:
        content = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        content = raw.decode("latin-1")  # GEDCOM 5.5 ANSEL fallback (best effort)
    if "0 HEAD" not in content and "INDI" not in content:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File does not appear to be a valid GEDCOM document",
        )
    # The duplicate check + parse + thousands of inserts are synchronous; run
    # them off the event loop so a large import doesn't stall every other
    # request. HTTPException raised inside propagates normally.
    return await run_in_threadpool(
        _guarded_import, db, tree, content, file.filename, file_hash, force
    )


@router.get("/export")
def export_tree(
    tree: FamilyTree = Depends(get_accessible_tree),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    # Read-only viewers may export, but must not WRITE the archive row (an
    # export by a viewer was mutating the owner's tree data).
    role = tree_role(db, tree, user)
    text = export_gedcom(db, tree, archive=role in ("owner", "editor"))
    # Two filename forms (RFC 6266): the plain `filename=` must be ASCII —
    # non-Latin-1 characters in a header value made Starlette raise, i.e. a
    # tree named in Greek or Chinese could not be exported at all — so it is
    # reduced to ASCII alphanumerics/space/_/-; `filename*=` carries the full
    # name percent-encoded for browsers that understand it (all current ones).
    ascii_name = "".join(
        c for c in tree.name if c.isascii() and (c.isalnum() or c in (" ", "_", "-"))
    ).strip() or "tree"
    utf8_name = quote(f"{tree.name.strip() or 'tree'}.ged", safe="")
    # The document is already fully in memory — a plain Response sends it in one
    # write. (StreamingResponse over BytesIO chunked it through a thread executor,
    # adding ~0.8s for a 255KB export.)
    return Response(
        content=text.encode("utf-8"),
        media_type="application/x-gedcom",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{ascii_name}.ged"; filename*=UTF-8\'\'{utf8_name}'
            )
        },
    )
