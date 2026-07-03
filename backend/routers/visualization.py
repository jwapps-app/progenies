"""Descendant and ancestor tree data.

The ancestor query is a PostgreSQL recursive CTE. The descendant
view supports *converging* family lines (e.g. a widow who remarries — her other
husband and his descendants must appear), which is a graph traversal that is
awkward to express purely in SQL: a recursive CTE first finds the full set of
reachable individuals (following children AND spouses' other children), and the
union-based descendant tree is then assembled from that set in Python with
per-individual de-duplication to break cycles.
"""
import sys
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from auth.deps import get_owned_tree
from database import get_db
from models import Child, Family, FamilyTree, Individual
from schemas import DescendantNode, DescendantUnion, TreeNode

router = APIRouter(prefix="/api/trees/{tree_id}", tags=["visualization"])

MAX_GENERATIONS = 500

# Reachable set for the descendant view: from each person follow (a) the
# children of any family they are a parent of, and (b) their spouses — so a
# spouse's OTHER children (and their descendants) become reachable, surfacing
# converging family lines. A path array breaks cycles.
_REACH_CTE = text(
    """
    WITH RECURSIVE reach AS (
        SELECT i.id AS id, ARRAY[i.id] AS path
        FROM individuals i
        WHERE i.id = :root AND i.tree_id = :tree
        UNION ALL
        SELECT nxt.id, r.path || nxt.id
        FROM reach r
        JOIN LATERAL (
            SELECT ch.individual_id AS id
            FROM families f
            JOIN children ch ON ch.family_id = f.id
            WHERE f.tree_id = :tree AND (f.husband_id = r.id OR f.wife_id = r.id)
            UNION
            SELECT CASE WHEN f.husband_id = r.id THEN f.wife_id ELSE f.husband_id END AS id
            FROM families f
            WHERE f.tree_id = :tree AND (f.husband_id = r.id OR f.wife_id = r.id)
        ) nxt ON nxt.id IS NOT NULL
        WHERE NOT (nxt.id = ANY(r.path)) AND array_length(r.path, 1) < :max_depth
    )
    SELECT DISTINCT id FROM reach
    """
)

_ANCESTOR_CTE = text(
    """
    WITH RECURSIVE ancestors AS (
        SELECT i.id AS individual_id, 0 AS generation, ARRAY[i.id] AS path
        FROM individuals i
        WHERE i.id = :root AND i.tree_id = :tree
        UNION ALL
        SELECT parent.individual_id, a.generation + 1, a.path || parent.individual_id
        FROM ancestors a
        JOIN children ch ON ch.individual_id = a.individual_id
        JOIN families f ON f.id = ch.family_id AND f.tree_id = :tree
        JOIN LATERAL (VALUES (f.husband_id), (f.wife_id)) AS parent(individual_id)
            ON parent.individual_id IS NOT NULL
        WHERE NOT (parent.individual_id = ANY(a.path)) AND a.generation < :max_gen
    )
    SELECT individual_id, MIN(generation) AS generation
    FROM ancestors
    GROUP BY individual_id
    """
)


def _individual_node(indi: Individual, generation: int) -> TreeNode:
    return TreeNode(
        id=indi.id,
        given_name=indi.given_name,
        middle_name=indi.middle_name,
        surname=indi.surname,
        sex=indi.sex,
        birth_date=indi.birth_date,
        death_date=indi.death_date,
        age=indi.age,
        is_unknown=indi.is_unknown,
        generation=generation,
        photo_url=indi.photo_url,
    )


def _desc_node(indi: Individual, generation: int) -> DescendantNode:
    return DescendantNode(
        id=indi.id,
        given_name=indi.given_name,
        middle_name=indi.middle_name,
        surname=indi.surname,
        sex=indi.sex,
        birth_date=indi.birth_date,
        death_date=indi.death_date,
        age=indi.age,
        is_unknown=indi.is_unknown,
        generation=generation,
        photo_url=indi.photo_url,
    )


def _require_individual(db: Session, tree: FamilyTree, individual_id: uuid.UUID) -> Individual:
    indi = db.get(Individual, individual_id)
    if indi is None or indi.tree_id != tree.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Individual not found")
    return indi


@router.get("/descendants/{individual_id}", response_model=DescendantNode)
def descendants(
    individual_id: uuid.UUID,
    tree: FamilyTree = Depends(get_owned_tree),
    db: Session = Depends(get_db),
) -> DescendantNode:
    root = _require_individual(db, tree, individual_id)

    reachable = {
        row.id
        for row in db.execute(
            _REACH_CTE, {"root": root.id, "tree": tree.id, "max_depth": MAX_GENERATIONS}
        ).all()
    }
    reachable.add(root.id)

    individuals = {
        i.id: i for i in db.scalars(select(Individual).where(Individual.id.in_(reachable)))
    }
    families = list(
        db.scalars(
            select(Family).where(
                Family.tree_id == tree.id,
                (Family.husband_id.in_(reachable)) | (Family.wife_id.in_(reachable)),
            )
        )
    )

    # Ordered children per family, each child's relation (per family), and each
    # person's families (as a parent). ONE query for all families' children —
    # a per-family loop here was an N+1 that dominated large-tree latency.
    fam_children: dict[uuid.UUID, list[uuid.UUID]] = {fam.id: [] for fam in families}
    child_relation: dict[tuple[uuid.UUID, uuid.UUID], str] = {}
    if families:
        all_kids = db.scalars(
            select(Child)
            .where(Child.family_id.in_(list(fam_children)))
            .order_by(Child.family_id, Child.birth_order)
        )
        for k in all_kids:
            fam_children[k.family_id].append(k.individual_id)
            child_relation[(k.family_id, k.individual_id)] = k.relation
    parent_families: dict[uuid.UUID, list[Family]] = {}
    for fam in families:
        for pid in (fam.husband_id, fam.wife_id):
            if pid is not None:
                parent_families.setdefault(pid, []).append(fam)

    sys.setrecursionlimit(10_000)
    visited: set[uuid.UUID] = set()

    def build(pid: uuid.UUID, depth: int, exclude_fam: uuid.UUID | None) -> DescendantNode | None:
        indi = individuals.get(pid)
        if indi is None:
            return None
        node = _desc_node(indi, depth)
        if pid in visited:
            return node  # already rendered elsewhere — leaf here to break cycles
        visited.add(pid)
        # Order this person's marriages by marriage_order (1st, 2nd, ...); fall
        # back to a stable order for any without one. Skip "ghost" families that
        # have no other spouse AND no children (e.g. left behind when a spouse
        # was deleted) — they would otherwise render as phantom extra marriages.
        def _is_empty(fam: Family) -> bool:
            partner = fam.wife_id if fam.husband_id == pid else fam.husband_id
            return partner is None and not fam_children.get(fam.id)

        person_fams = [
            fam
            for fam in parent_families.get(pid, [])
            if (exclude_fam is None or fam.id != exclude_fam) and not _is_empty(fam)
        ]
        person_fams.sort(key=lambda f: (f.marriage_order is None, f.marriage_order or 0, str(f.id)))
        for idx, fam in enumerate(person_fams, start=1):
            partner_id = fam.wife_id if fam.husband_id == pid else fam.husband_id
            # The spouse's OTHER marriages are expanded (exclude this family),
            # which is how converging lines surface.
            spouse_node = build(partner_id, depth, fam.id) if partner_id is not None else None
            children = []
            for cid in fam_children.get(fam.id, []):
                child = build(cid, depth + 1, None)
                if child is not None:
                    child.relation = child_relation.get((fam.id, cid), "biological")
                    children.append(child)
            node.unions.append(
                DescendantUnion(
                    spouse=spouse_node,
                    children=children,
                    ordinal=idx,
                    gap=fam.gap,
                    unmarried=fam.unmarried,
                    divorced=fam.divorced_date is not None,
                )
            )
        return node

    result = build(root.id, 0, None)
    assert result is not None  # root is always present
    return result


@router.get("/ancestors/{individual_id}", response_model=TreeNode)
def ancestors(
    individual_id: uuid.UUID,
    tree: FamilyTree = Depends(get_owned_tree),
    db: Session = Depends(get_db),
) -> TreeNode:
    root = _require_individual(db, tree, individual_id)
    rows = db.execute(
        _ANCESTOR_CTE, {"root": root.id, "tree": tree.id, "max_gen": MAX_GENERATIONS}
    ).all()
    generation_by_id = {row.individual_id: row.generation for row in rows}
    member_ids = set(generation_by_id)

    individuals = {
        i.id: i for i in db.scalars(select(Individual).where(Individual.id.in_(member_ids)))
    }
    families = list(
        db.scalars(
            select(Family).where(
                Family.tree_id == tree.id,
                (Family.husband_id.in_(member_ids)) | (Family.wife_id.in_(member_ids)),
            )
        )
    )

    nodes = {iid: _individual_node(individuals[iid], generation_by_id[iid]) for iid in member_ids}

    # For an ancestor chart, a node's `children` field holds its parents (the
    # next generation outward), which is the hierarchy D3 renders.
    child_to_family = {}
    if families:
        fam_by_id = {fam.id: fam for fam in families}
        for ch in db.scalars(select(Child).where(Child.family_id.in_(list(fam_by_id)))):
            if ch.individual_id in nodes:
                child_to_family[ch.individual_id] = fam_by_id[ch.family_id]

    for child_id, fam in child_to_family.items():
        child_node = nodes[child_id]
        for parent_id in (fam.husband_id, fam.wife_id):
            if parent_id in nodes:
                parent_node = nodes[parent_id]
                if not any(p.id == parent_node.id for p in child_node.children):
                    child_node.children.append(parent_node)

    return nodes[root.id]
