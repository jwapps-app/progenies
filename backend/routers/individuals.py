"""Individual CRUD routes scoped to an owned tree."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth.deps import get_accessible_tree, get_editable_tree, require_in_tree
from database import get_db
from models import Child, Citation, Family, FamilyTree, Individual
from schemas import IndividualCreate, IndividualOut, IndividualUpdate, MergeRequest

router = APIRouter(prefix="/api/trees/{tree_id}/individuals", tags=["individuals"])


@router.get("", response_model=list[IndividualOut])
def list_individuals(
    include_photos: bool = False,
    tree: FamilyTree = Depends(get_accessible_tree),
    db: Session = Depends(get_db),
) -> list[IndividualOut]:
    """List individuals. Photo thumbnails (base64 data URLs) are OMITTED by
    default — they multiply the payload of every list fetch; the detail
    endpoint (and the visualization endpoints, which render them) still
    include them. Pass include_photos=true to embed them here too."""
    if include_photos:
        people = db.scalars(
            select(Individual)
            .where(Individual.tree_id == tree.id)
            .order_by(Individual.surname, Individual.given_name)
        )
        return [IndividualOut.model_validate(p) for p in people]
    # Omit the photo column from the SELECT itself, so the base64 blobs never
    # cross the database wire. (Loading full rows and nulling the DTO field
    # still fetched every photo; deferring the column would lazy-load it
    # per row the moment serialization touched it.) The DTO's photo_url
    # defaults to None.
    stmt = (
        select(*(c for c in Individual.__table__.c if c.key != "photo_url"))
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

    # Re-point family partner slots from the duplicate to the survivor.
    for fam in db.scalars(
        select(Family).where(
            Family.tree_id == tree.id,
            (Family.husband_id == dup.id) | (Family.wife_id == dup.id),
        )
    ):
        if fam.husband_id == dup.id:
            fam.husband_id = survivor.id
        if fam.wife_id == dup.id:
            fam.wife_id = survivor.id
    db.flush()

    # Re-point child links (avoiding a duplicate link in the same family).
    # The survivor's existing memberships come from ONE query up front — a
    # per-link db.get probe was an N+1.
    survivor_child_fams = set(
        db.scalars(select(Child.family_id).where(Child.individual_id == survivor.id))
    )
    for ch in list(db.scalars(select(Child).where(Child.individual_id == dup.id))):
        if ch.family_id not in survivor_child_fams:
            db.add(
                Child(
                    family_id=ch.family_id,
                    individual_id=survivor.id,
                    birth_order=ch.birth_order,
                    relation=ch.relation,
                )
            )
            survivor_child_fams.add(ch.family_id)
        db.delete(ch)

    # Re-point citations.
    for cit in db.scalars(select(Citation).where(Citation.individual_id == dup.id)):
        cit.individual_id = survivor.id
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
