"""Descendant and ancestor tree data.

The ancestor query is a PostgreSQL recursive CTE. The descendant
view supports *converging* family lines (e.g. a widow who remarries — her other
husband and his descendants must appear), which is a graph traversal that is
awkward to express purely in SQL: a recursive CTE first finds the full set of
reachable individuals (following children AND spouses' other children), and the
union-based descendant tree is then assembled from that set in Python with
per-individual de-duplication to break cycles.
"""
import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import select, text
from sqlalchemy.orm import Session, defer

from auth.deps import get_accessible_tree, require_in_tree
from database import get_db
from models import Child, Family, FamilyTree, Individual
from schemas import DescendantNode, DescendantUnion, TreeNode

router = APIRouter(prefix="/api/trees/{tree_id}", tags=["visualization"])

MAX_GENERATIONS = 500

# Reachable set for the descendant view: from each person follow (a) the
# children of any family they are a parent of, and (b) their spouses — so a
# spouse's OTHER children (and their descendants) become reachable, surfacing
# converging family lines.
#
# UNION (not UNION ALL) deduplicates the working set, so each individual is
# visited at most once. This both breaks cycles and — critically — avoids the
# exponential path explosion the old ARRAY[]-path version suffered on dense,
# highly-convergent trees, where the same nodes were re-traversed along every
# distinct path. Termination no longer needs a depth cap: once no new ids
# appear, the recursion stops.
_REACH_CTE = text(
    """
    WITH RECURSIVE reach(id) AS (
        SELECT i.id
        FROM individuals i
        WHERE i.id = :root AND i.tree_id = :tree
        UNION
        SELECT nxt.id
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
    )
    SELECT id FROM reach
    """
)

# Ancestor closure as (individual, generation) rows walking child -> parents.
#
# UNION (not UNION ALL) deduplicates the working set, so pedigree collapse (the
# same ancestor reachable along many distinct lines) can't enumerate every path
# — the old ARRAY[]-path version did exactly that and went exponential on dense
# trees. Without a per-path cycle check, a data cycle would otherwise recurse
# forever at ever-increasing generation numbers, so the :max_gen bound is the
# termination backstop (and thus the cycle guard).
_ANCESTOR_CTE = text(
    """
    WITH RECURSIVE ancestors(individual_id, generation) AS (
        SELECT i.id, 0
        FROM individuals i
        WHERE i.id = :root AND i.tree_id = :tree
        UNION
        SELECT parent.individual_id, a.generation + 1
        FROM ancestors a
        JOIN children ch ON ch.individual_id = a.individual_id
        JOIN families f ON f.id = ch.family_id AND f.tree_id = :tree
        JOIN LATERAL (VALUES (f.husband_id), (f.wife_id)) AS parent(individual_id)
            ON parent.individual_id IS NOT NULL
        WHERE a.generation < :max_gen
    )
    SELECT individual_id, MIN(generation) AS generation
    FROM ancestors
    GROUP BY individual_id
    """
)

# The node builders below only emit the fields the charts render, so the
# columns they never touch are deferred in the bulk loads — notes and places
# can dominate the wire size of a large tree. Deferral (not omission) is safe
# ONLY because nothing downstream accesses those attributes; touching one
# would trigger a per-row lazy load.
_UNRENDERED_COLUMNS = (
    defer(Individual.notes),
    defer(Individual.birth_place),
    defer(Individual.death_place),
    defer(Individual.gedcom_xref),
)


def _individual_node(indi: Individual, generation: int) -> TreeNode:
    return TreeNode(
        id=indi.id,
        given_name=indi.given_name,
        middle_name=indi.middle_name,
        surname=indi.surname,
        married_name=indi.married_name,
        nickname=indi.nickname,
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
        married_name=indi.married_name,
        nickname=indi.nickname,
        sex=indi.sex,
        birth_date=indi.birth_date,
        death_date=indi.death_date,
        age=indi.age,
        is_unknown=indi.is_unknown,
        generation=generation,
        photo_url=indi.photo_url,
    )


def build_descendants(db: Session, tree: FamilyTree, individual_id: uuid.UUID) -> DescendantNode:
    """Assemble the descendant (union) tree for a root person. Shared by the
    authenticated route and the public share-link route."""
    root = require_in_tree(db, tree, Individual, individual_id)

    reachable = {
        row.id
        for row in db.execute(_REACH_CTE, {"root": root.id, "tree": tree.id}).all()
    }
    reachable.add(root.id)

    individuals = {
        i.id: i
        for i in db.scalars(
            select(Individual)
            .where(Individual.id.in_(reachable))
            .options(*_UNRENDERED_COLUMNS)
        )
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

    visited: set[uuid.UUID] = set()

    def _expand(
        node: DescendantNode,
        pid: uuid.UUID,
        depth: int,
        exclude_fam: uuid.UUID | None,
        stack: list,
    ) -> None:
        # Order this person's marriages by marriage_order (1st, 2nd, ...); fall
        # back to a stable order for any without one. Skip "ghost" families that
        # have no other spouse AND no children (e.g. left behind when a spouse
        # was deleted) — they would otherwise render as phantom extra marriages.
        def _is_empty(fam: Family) -> bool:
            partner = fam.wife_id if fam.husband_id == pid else fam.husband_id
            return partner is None and not fam_children.get(fam.id)

        person_fams = [fam for fam in parent_families.get(pid, []) if not _is_empty(fam)]
        person_fams.sort(key=lambda f: (f.marriage_order is None, f.marriage_order or 0, str(f.id)))
        pending: list[tuple] = []
        # Ordinals are positions in the person's FULL marriage list, including
        # the union this node was reached through (exclude_fam) — otherwise a
        # spouse whose first marriage is the rendered union would have their
        # second marriage mislabeled "1st".
        for idx, fam in enumerate(person_fams, start=1):
            if exclude_fam is not None and fam.id == exclude_fam:
                continue
            union = DescendantUnion(
                ordinal=idx,
                gap=fam.gap,
                unmarried=fam.unmarried,
                divorced=fam.divorced_date is not None,
            )
            node.unions.append(union)
            partner_id = fam.wife_id if fam.husband_id == pid else fam.husband_id
            # The spouse's OTHER marriages are expanded (exclude this family),
            # which is how converging lines surface.
            if partner_id is not None:
                pending.append((partner_id, depth, fam.id, union, None))
            for cid in fam_children.get(fam.id, []):
                pending.append(
                    (cid, depth + 1, None, union, child_relation.get((fam.id, cid), "biological"))
                )
        # Reversed so the stack pops in declaration order — spouse first, then
        # children in birth order, then the next union — matching the traversal
        # order the recursive version had (which decides where a shared person
        # renders in full vs. leafs out).
        stack.extend(reversed(pending))

    # Iterative depth-first assembly with an explicit stack — deep single-line
    # genealogies (biblical trees) blew past Python's recursion limit here.
    # Work items: (person, depth, family to exclude, target union, relation);
    # relation is None when the person attaches as the union's spouse.
    root_node = _desc_node(individuals[root.id], 0)
    visited.add(root.id)
    stack: list[tuple[uuid.UUID, int, uuid.UUID | None, DescendantUnion, str | None]] = []
    _expand(root_node, root.id, 0, None, stack)
    while stack:
        pid, depth, exclude_fam, union, relation = stack.pop()
        indi = individuals.get(pid)
        if indi is None:
            continue
        node = _desc_node(indi, depth)
        if relation is None:
            union.spouse = node
        else:
            node.relation = relation
            union.children.append(node)
        if pid in visited:
            continue  # already rendered elsewhere — leaf here to break cycles
        visited.add(pid)
        _expand(node, pid, depth, exclude_fam, stack)

    return root_node


def build_ancestors(db: Session, tree: FamilyTree, individual_id: uuid.UUID) -> TreeNode:
    """Assemble the ancestor (pedigree) tree for a root person. Shared by the
    authenticated route and the public share-link route."""
    root = require_in_tree(db, tree, Individual, individual_id)
    rows = db.execute(
        _ANCESTOR_CTE, {"root": root.id, "tree": tree.id, "max_gen": MAX_GENERATIONS}
    ).all()
    generation_by_id = {row.individual_id: row.generation for row in rows}
    member_ids = set(generation_by_id)

    individuals = {
        i.id: i
        for i in db.scalars(
            select(Individual)
            .where(Individual.id.in_(member_ids))
            .options(*_UNRENDERED_COLUMNS)
        )
    }
    families = list(
        db.scalars(
            select(Family).where(
                Family.tree_id == tree.id,
                (Family.husband_id.in_(member_ids)) | (Family.wife_id.in_(member_ids)),
            )
        )
    )

    child_to_family = {}
    if families:
        fam_by_id = {fam.id: fam for fam in families}
        for ch in db.scalars(select(Child).where(Child.family_id.in_(list(fam_by_id)))):
            if ch.individual_id in individuals:
                child_to_family[ch.individual_id] = fam_by_id[ch.family_id]

    # Each member's parents. A self-referential family (someone recorded as
    # their own parent) is skipped — it would otherwise link a node to itself.
    parents_of: dict[uuid.UUID, list[uuid.UUID]] = {}
    for child_id, fam in child_to_family.items():
        parents: list[uuid.UUID] = []
        for parent_id in (fam.husband_id, fam.wife_id):
            if parent_id in individuals and parent_id != child_id and parent_id not in parents:
                parents.append(parent_id)
        parents_of[child_id] = parents

    # For an ancestor chart, a node's `children` field holds its parents (the
    # next generation outward), which is the hierarchy D3 renders.
    #
    # A FRESH node is created per parent-edge, but any given ancestor is only
    # EXPANDED once — later appearances stay leaf stubs, mirroring how
    # build_descendants handles revisits. Sharing one node object across every
    # line it appears on (the old approach) re-serialized shared ancestors once
    # per distinct path, which went exponential under pedigree collapse.
    root_node = _individual_node(individuals[root.id], generation_by_id[root.id])
    expanded: set[uuid.UUID] = {root.id}
    stack: list[tuple[TreeNode, uuid.UUID]] = [(root_node, root.id)]
    while stack:
        node, pid = stack.pop()
        for parent_id in parents_of.get(pid, ()):
            parent_node = _individual_node(individuals[parent_id], generation_by_id[parent_id])
            node.children.append(parent_node)
            if parent_id not in expanded:
                expanded.add(parent_id)
                stack.append((parent_node, parent_id))

    return root_node


@router.get("/descendants/{individual_id}", response_model=DescendantNode)
def descendants(
    individual_id: uuid.UUID,
    tree: FamilyTree = Depends(get_accessible_tree),
    db: Session = Depends(get_db),
) -> DescendantNode:
    return build_descendants(db, tree, individual_id)


@router.get("/ancestors/{individual_id}", response_model=TreeNode)
def ancestors(
    individual_id: uuid.UUID,
    tree: FamilyTree = Depends(get_accessible_tree),
    db: Session = Depends(get_db),
) -> TreeNode:
    return build_ancestors(db, tree, individual_id)
