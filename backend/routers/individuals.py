"""Individual CRUD routes scoped to an owned tree."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from auth.deps import get_accessible_tree, get_editable_tree, require_in_tree
from database import get_db
from models import Child, Citation, Family, FamilyTree, Individual
from schemas import IndividualCreate, IndividualOut, IndividualUpdate, MergeRequest

router = APIRouter(prefix="/api/trees/{tree_id}/individuals", tags=["individuals"])

# Upper bound on one photo batch. Generous enough that a whole large chart is
# one or two requests, small enough that a single call can't be made to pull
# every thumbnail in the database.
PHOTO_BATCH_MAX = 2000


class PhotoBatchRequest(BaseModel):
    ids: list[uuid.UUID] = Field(max_length=PHOTO_BATCH_MAX)


def photos_for(db: Session, tree: FamilyTree, ids: list[uuid.UUID]) -> dict[str, str]:
    """The photo thumbnails for the given ids, keyed by id — only ids that
    belong to this tree AND have a photo appear. Shared by the authenticated
    batch route (POST /api/trees/{tree_id}/photos, registered alongside the
    chart routes in routers/visualization.py since it serves the chart) and
    the public share-link route. SELECTs just id + photo so no other column
    rides along."""
    if not ids:
        return {}
    stmt = select(Individual.id, Individual.photo_url).where(
        Individual.tree_id == tree.id,
        Individual.id.in_(set(ids)),
        Individual.photo_url.is_not(None),
    )
    return {str(pid): photo for pid, photo in db.execute(stmt) if photo}


@router.get("", response_model=list[IndividualOut], response_model_exclude_unset=True)
def list_individuals(
    include_photos: bool = False,
    include_details: bool = False,
    tree: FamilyTree = Depends(get_accessible_tree),
    db: Session = Depends(get_db),
) -> list[IndividualOut]:
    """List individuals. Two blobs are OMITTED from the wire by default:

    * photo thumbnails (base64 data URLs) — they multiply the payload of every
      list fetch; the detail endpoint and the batched photos endpoint serve
      them. Pass include_photos=true to embed them here.
    * free-text notes — measured at roughly a third of a large tree's list
      payload, and only the detail panel and edit form ever show them (both
      fetch the person's detail). Pass include_details=true to embed them.

    Birth/death places stay: the search box, the duplicate finder's summaries
    and the detail panel all read them straight off the list. Omitted fields
    are absent from the JSON (not null), so a client can tell "no notes" from
    "not loaded" — the edit form relies on that to never save a blank over
    notes it never received."""
    omitted: set[str] = set()
    if not include_photos:
        omitted.add("photo_url")
    if not include_details:
        omitted.add("notes")
    if not omitted:
        people = db.scalars(
            select(Individual)
            .where(Individual.tree_id == tree.id)
            .order_by(Individual.surname, Individual.given_name)
        )
        return [IndividualOut.model_validate(p) for p in people]
    # Omit the columns from the SELECT itself, so the blobs never cross the
    # database wire. (Loading full rows and nulling the DTO fields still fetched
    # every one; deferring a column would lazy-load it per row the moment
    # serialization touched it.) The omitted DTO fields stay unset, which
    # response_model_exclude_unset drops from the JSON.
    stmt = (
        select(*(c for c in Individual.__table__.c if c.key not in omitted))
        .where(Individual.tree_id == tree.id)
        .order_by(Individual.surname, Individual.given_name)
    )
    return [IndividualOut.model_validate(dict(row._mapping)) for row in db.execute(stmt)]


@router.post("", response_model=IndividualOut, status_code=status.HTTP_201_CREATED)
def create_individual(
    payload: IndividualCreate,
    tree: FamilyTree = Depends(get_editable_tree),
    db: Session = Depends(get_db),
) -> Individual:
    indi = Individual(tree_id=tree.id, **payload.model_dump())
    db.add(indi)
    db.commit()
    db.refresh(indi)
    return indi


@router.get("/{individual_id}", response_model=IndividualOut)
def get_individual(
    individual_id: uuid.UUID,
    tree: FamilyTree = Depends(get_accessible_tree),
    db: Session = Depends(get_db),
) -> Individual:
    return require_in_tree(db, tree, Individual, individual_id)


@router.put("/{individual_id}", response_model=IndividualOut)
def update_individual(
    individual_id: uuid.UUID,
    payload: IndividualUpdate,
    tree: FamilyTree = Depends(get_editable_tree),
    db: Session = Depends(get_db),
) -> Individual:
    indi = require_in_tree(db, tree, Individual, individual_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(indi, field, value)
    db.commit()
    db.refresh(indi)
    return indi


@router.delete("/{individual_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_individual(
    individual_id: uuid.UUID,
    tree: FamilyTree = Depends(get_editable_tree),
    db: Session = Depends(get_db),
) -> None:
    indi = require_in_tree(db, tree, Individual, individual_id)
    # Families this person is a partner in — after deletion the DB sets their
    # husband/wife reference to NULL, which can leave a meaningless "ghost"
    # family (one or zero partners and no children). Clean those up.
    affected = list(
        db.scalars(
            select(Family).where(
                Family.tree_id == tree.id,
                (Family.husband_id == indi.id) | (Family.wife_id == indi.id),
            )
        )
    )
    db.delete(indi)
    db.flush()  # applies ON DELETE SET NULL to the affected families
    if affected:
        # ONE query for every affected family: which are now ghosts (a partner
        # slot NULLed and no children)? A per-family refresh + exists probe
        # here was 2N round trips.
        ghost_ids = set(
            db.scalars(
                select(Family.id).where(
                    Family.id.in_([fam.id for fam in affected]),
                    (Family.husband_id.is_(None)) | (Family.wife_id.is_(None)),
                    ~select(Child.individual_id).where(Child.family_id == Family.id).exists(),
                )
            )
        )
        for fam in affected:
            if fam.id in ghost_ids:
                db.delete(fam)
    db.commit()


_MERGE_FILL_FIELDS = (
    "given_name",
    "middle_name",
    "surname",
    "married_name",
    "nickname",
    "birth_date",
    "birth_place",
    "death_date",
    "death_place",
    "age",
    "notes",
    "photo_url",
    "gedcom_xref",
)


@router.post("/{individual_id}/merge", status_code=status.HTTP_204_NO_CONTENT)
def merge_individual(
    individual_id: uuid.UUID,
    payload: MergeRequest,
    tree: FamilyTree = Depends(get_editable_tree),
    db: Session = Depends(get_db),
) -> None:
    """Merge the `duplicate_id` record into the survivor (`individual_id`):
    re-point all family/child/citation references, fill the survivor's blank
    fields from the duplicate, then delete the duplicate."""
    survivor = require_in_tree(db, tree, Individual, individual_id)
    dup = require_in_tree(db, tree, Individual, payload.duplicate_id)
    if survivor.id == dup.id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Cannot merge a person into themselves"
        )

    # Fill the survivor's empty fields from the duplicate.
    for field in _MERGE_FILL_FIELDS:
        if not getattr(survivor, field) and getattr(dup, field):
            setattr(survivor, field, getattr(dup, field))
    if survivor.sex in (None, "U") and dup.sex not in (None, "U"):
        survivor.sex = dup.sex
    if not dup.is_unknown:
        survivor.is_unknown = False
    db.flush()

    # Re-point family partner slots from the duplicate to the survivor — one
    # UPDATE per slot rather than loading every family and saving them back
    # one row at a time.
    for slot in (Family.husband_id, Family.wife_id):
        db.execute(
            update(Family)
            .where(Family.tree_id == tree.id, slot == dup.id)
            .values({slot.key: survivor.id})
        )

    # Re-point child links. A link in a family the survivor is ALREADY a child
    # of would collide on the (family, individual) primary key, so those are
    # dropped instead of moved: one UPDATE for the movable links, one DELETE
    # for whatever remains (the collisions). The survivor's existing
    # memberships come from ONE query up front.
    survivor_child_fams = set(
        db.scalars(select(Child.family_id).where(Child.individual_id == survivor.id))
    )
    db.execute(
        update(Child)
        .where(Child.individual_id == dup.id, Child.family_id.not_in(survivor_child_fams))
        .values(individual_id=survivor.id)
    )
    db.execute(delete(Child).where(Child.individual_id == dup.id))

    # Re-point citations in ONE statement (the per-row loop was an N+1 on a
    # well-sourced person).
    db.execute(
        update(Citation).where(Citation.individual_id == dup.id).values(individual_id=survivor.id)
    )
    db.flush()

    # Re-pointing can leave TWO family rows for the same couple (survivor and
    # duplicate were each recorded as married to the same third person). Merge
    # them: move child links across, fill missing marriage details, drop the
    # extra — otherwise the couple exports with duplicate FAMS records and
    # their children split across two family units.
    survivor_fams = list(
        db.scalars(
            select(Family).where(
                Family.tree_id == tree.id,
                (Family.husband_id == survivor.id) | (Family.wife_id == survivor.id),
            )
        )
    )
    # All child links of the survivor's families in ONE query, keyed by
    # (family, individual) — a per-child db.get probe was an N+1.
    children_by_family: dict[uuid.UUID, dict[uuid.UUID, Child]] = {
        fam.id: {} for fam in survivor_fams
    }
    for ch in db.scalars(select(Child).where(Child.family_id.in_(list(children_by_family)))):
        children_by_family[ch.family_id][ch.individual_id] = ch

    kept_by_pair: dict[tuple, Family] = {}
    for fam in survivor_fams:
        pair = (fam.husband_id, fam.wife_id)
        keep = kept_by_pair.get(pair)
        if keep is None:
            kept_by_pair[pair] = fam
            continue
        for ch in list(children_by_family[fam.id].values()):
            if ch.individual_id not in children_by_family[keep.id]:
                moved = Child(
                    family_id=keep.id,
                    individual_id=ch.individual_id,
                    birth_order=ch.birth_order,
                    relation=ch.relation,
                )
                db.add(moved)
                children_by_family[keep.id][ch.individual_id] = moved
            db.delete(ch)
        for field in ("married_date", "married_place", "divorced_date", "notes", "marriage_order", "gedcom_xref"):
            if not getattr(keep, field) and getattr(fam, field):
                setattr(keep, field, getattr(fam, field))
        db.flush()
        db.delete(fam)
    db.flush()

    # The merge can create a self-marriage (survivor married the duplicate).
    # A childless one is just dropped; one WITH children becomes a single-parent
    # family instead — deleting it would cascade the child links away and
    # silently orphan the couple's kids from this parent.
    for fam in list(
        db.scalars(
            select(Family).where(
                Family.tree_id == tree.id,
                Family.husband_id == survivor.id,
                Family.wife_id == survivor.id,
            )
        )
    ):
        has_children = db.scalar(select(Child.individual_id).where(Child.family_id == fam.id))
        if has_children is not None:
            fam.wife_id = None
        else:
            db.delete(fam)

    db.delete(dup)
    db.commit()
