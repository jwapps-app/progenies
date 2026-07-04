import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import DescendantPyramid, {
  type MagnifyMode,
} from "../components/visualizations/DescendantPyramid";
import AncestorChart from "../components/visualizations/AncestorChart";
import Modal from "../components/ui/Modal";
import ThemeToggle from "../components/ui/ThemeToggle";
import { useTheme } from "../store/theme";
import { describeRelationship, relationshipPath } from "../utils/relationship";
import { findWarnings } from "../utils/warnings";
import { exportChartPng } from "../utils/exportImage";
import { findDuplicates, personSummary } from "../utils/duplicates";
import PersonForm, { PersonFields, fieldsToPayload } from "../components/PersonForm";
import type { AncestorNode, ChildRef, Family, ImportSummary, Individual, TreeNode } from "../types";
import { displayName } from "../types";
import {
  effectiveOrientation,
  setTreeOverride,
  type Orientation,
} from "../utils/orientation";

type ModalKind =
  | "add"
  | "edit"
  | "addSpouse"
  | "addChild"
  | "addParent"
  | "addDescendant"
  | "editFamily"
  | "relate"
  | "warnings"
  | "duplicates"
  | null;

interface FamilyForm {
  married: boolean;
  married_date: string;
  married_place: string;
  divorced_date: string;
}
type UndoEntry = { label: string; run: () => Promise<unknown> };

/** Best-effort birth year from a free-text date ("c. 1850", "ABT 1900 BC",
 * "1780"). BC years are negative so they sort before AD. Returns null when no
 * year is present (those children sort last when ordering by birth). */
function birthYear(date: string | null | undefined): number | null {
  if (!date) return null;
  const m = date.match(/\d{1,5}/);
  if (!m) return null;
  const year = parseInt(m[0], 10);
  return /\bb\.?\s*c\.?(\s*e\.?)?\b/i.test(date) ? -year : year;
}

/** Returns a callback whose IDENTITY never changes but which always invokes the
 * latest `fn`. Handlers passed to the chart components must be stable — they sit
 * in the chart effect's dependency array, and an unstable identity would tear
 * down and redraw the whole SVG (1,900+ nodes) on every unrelated re-render
 * (e.g. each keystroke in the search box). */
function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

export default function TreeViewPage() {
  const { treeId } = useParams<{ treeId: string }>();
  const [individuals, setIndividuals] = useState<Individual[]>([]);
  const [families, setFamilies] = useState<Family[]>([]);
  const [rootId, setRootId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [treeData, setTreeData] = useState<TreeNode | null>(null);
  const [ancestorData, setAncestorData] = useState<AncestorNode | null>(null);
  const [viewMode, setViewMode] = useState<"descendants" | "ancestors">("descendants");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showConverging, setShowConverging] = useState(true);
  const [magnify, setMagnify] = useState<MagnifyMode>("loupe");
  const [orientation, setOrientation] = useState<Orientation>(() =>
    treeId ? effectiveOrientation(treeId) : "vertical"
  );
  const theme = useTheme((s) => s.theme);
  // Re-read the effective orientation when switching trees.
  useEffect(() => {
    if (treeId) setOrientation(effectiveOrientation(treeId));
  }, [treeId]);
  // Flip THIS tree's orientation (persists as a per-tree override of the global default).
  const toggleOrientation = () => {
    if (!treeId) return;
    const next: Orientation = orientation === "vertical" ? "horizontal" : "vertical";
    setTreeOverride(treeId, next);
    setOrientation(next);
  };
  // Relationship calculator: the people being compared (first is the reference).
  const [relateIds, setRelateIds] = useState<string[]>([]);
  // Person search.
  const [search, setSearch] = useState("");
  // Relationship path highlighted on the chart (person ids), or null.
  const [highlightIds, setHighlightIds] = useState<Set<string> | null>(null);
  // Pairs the user confirmed are NOT duplicates (sorted-id keys "a|b").
  const [dismissedPairs, setDismissedPairs] = useState<Set<string>>(new Set());
  // Data-integrity warnings the user reviewed and dismissed (stable keys).
  const [dismissedWarningKeys, setDismissedWarningKeys] = useState<Set<string>>(new Set());
  // Married-in spouses whose family-of-origin has been expanded above them in the
  // chart, keyed by person id → the (pruned) descendant tree of their topmost
  // ancestor, so the upward graft shows parents, grandparents AND siblings.
  const [expandedFamily, setExpandedFamily] = useState<Record<string, TreeNode>>({});
  // Add-spouse modal: create a new person, or link one already in the tree.
  const [spouseMode, setSpouseMode] = useState<"new" | "existing">("new");
  const [linkSpouseId, setLinkSpouseId] = useState<string>("");
  // Whether the new pairing is a marriage (vs. known co-parents who never married).
  const [spouseMarried, setSpouseMarried] = useState(true);
  // Family editor: the family being edited and its form fields.
  const [editFamilyId, setEditFamilyId] = useState<string | null>(null);
  const [famForm, setFamForm] = useState<FamilyForm>({
    married: true,
    married_date: "",
    married_place: "",
    divorced_date: "",
  });

  const [modal, setModal] = useState<ModalKind>(null);
  const [busy, setBusy] = useState(false);
  const [childFamilyChoice, setChildFamilyChoice] = useState<string>("new");
  const [childRelation, setChildRelation] = useState<string>("biological");
  // Undo stack — each entry knows how to reverse the change that pushed it.
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);

  function pushUndo(label: string, run: () => Promise<unknown>) {
    setUndoStack((s) => [...s.slice(-19), { label, run }]);
  }

  async function handleUndo() {
    const entry = undoStack[undoStack.length - 1];
    if (!entry || !treeId) return;
    setBusy(true);
    setError(null);
    try {
      await entry.run();
      setUndoStack((s) => s.slice(0, -1));
      await reload();
    } catch (err) {
      setError(err instanceof Error ? `Undo failed: ${err.message}` : "Undo failed");
    } finally {
      setBusy(false);
    }
  }

  // Click a person → focus that branch (re-root) and open their panel.
  function handleSelect(id: string) {
    setSelectedId(id);
    setRootId(id);
  }

  function showWholeTree() {
    if (individuals.length > 0) setRootId(defaultRoot(individuals, families));
    setSelectedId(null);
  }

  function handleExportImage() {
    const svg = document.querySelector("main svg") as SVGSVGElement | null;
    if (!svg) return;
    const bg = theme === "dark" ? "#0b1220" : "#ffffff";
    exportChartPng(svg, `family-tree-${viewMode}.png`, bg);
  }

  // Merge `duplicateId` into `survivorId` (combines families, children, details).
  async function handleMerge(survivorId: string, duplicateId: string) {
    if (!treeId) return;
    const sName = displayName(personById.get(survivorId));
    const dName = displayName(personById.get(duplicateId));
    if (!confirm(`Merge ${dName} into ${sName}? ${dName}'s relationships move to ${sName}, and ${dName} is deleted. This can't be undone.`))
      return;
    setBusy(true);
    setError(null);
    try {
      await api.mergeIndividual(treeId, survivorId, duplicateId);
      if (rootId === duplicateId) setRootId(survivorId);
      if (selectedId === duplicateId) setSelectedId(survivorId);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to merge");
    } finally {
      setBusy(false);
    }
  }

  async function loadData() {
    if (!treeId) return;
    setLoading(true);
    try {
      const [inds, fams] = await Promise.all([
        api.listIndividuals(treeId),
        api.listFamilies(treeId),
      ]);
      setIndividuals(inds);
      setFamilies(fams);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tree data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeId]);

  // Keep rootId valid as data changes; default to the top ancestor (the whole
  // tree) rather than the first alphabetical name.
  useEffect(() => {
    if (individuals.length === 0) {
      if (rootId !== null) setRootId(null);
      return;
    }
    if (!rootId || !individuals.some((i) => i.id === rootId)) {
      setRootId(defaultRoot(individuals, families));
    }
  }, [individuals, families, rootId]);

  // The current root's parent (for the "up a level" button), preferring the
  // bloodline parent already shown when possible.
  const rootParentId = rootId ? parentOf(rootId, families) : null;

  // Fetch the chart data for the current view (descendants or ancestors) whenever
  // the root, view mode, or data changes.
  useEffect(() => {
    if (!treeId || !rootId) {
      setTreeData(null);
      setAncestorData(null);
      return;
    }
    let cancelled = false;
    const onErr = (err: unknown) =>
      !cancelled && setError(err instanceof Error ? err.message : "Failed to load chart");
    if (viewMode === "ancestors") {
      api.ancestors(treeId, rootId).then((d) => !cancelled && setAncestorData(d)).catch(onErr);
    } else {
      api.descendants(treeId, rootId).then((d) => !cancelled && setTreeData(d)).catch(onErr);
    }
    return () => {
      cancelled = true;
    };
  }, [treeId, rootId, reloadKey, viewMode]);

  async function reload() {
    await loadData();
    setReloadKey((k) => k + 1);
  }

  const personById = useMemo(
    () => new Map(individuals.map((i) => [i.id, i])),
    [individuals]
  );
  const selected = selectedId ? personById.get(selectedId) ?? null : null;

  // Families in which a given person is a spouse, with the co-parent resolved.
  function spouseFamiliesOf(personId: string) {
    return families
      .filter((f) => f.husband_id === personId || f.wife_id === personId)
      .map((f) => {
        const coParentId = f.husband_id === personId ? f.wife_id : f.husband_id;
        const coParent = coParentId ? personById.get(coParentId) ?? null : null;
        return { family: f, coParent };
      });
  }

  // The person's parents (resolved individuals) across the families they're a child of.
  function parentsOf(personId: string): Individual[] {
    const out: Individual[] = [];
    const seen = new Set<string>();
    for (const f of families) {
      if (!f.children.some((c) => c.individual_id === personId)) continue;
      for (const pid of [f.husband_id, f.wife_id]) {
        if (pid && !seen.has(pid)) {
          const p = personById.get(pid);
          if (p) {
            seen.add(pid);
            out.push(p);
          }
        }
      }
    }
    return out;
  }

  // The person's children (resolved, ordered by birth order then family).
  function childrenOf(personId: string): Individual[] {
    const out: Individual[] = [];
    const seen = new Set<string>();
    for (const f of families) {
      if (f.husband_id !== personId && f.wife_id !== personId) continue;
      const kids = [...f.children].sort(
        (a, b) => (a.birth_order ?? Infinity) - (b.birth_order ?? Infinity)
      );
      for (const c of kids) {
        if (seen.has(c.individual_id)) continue;
        const p = personById.get(c.individual_id);
        if (p) {
          seen.add(c.individual_id);
          out.push(p);
        }
      }
    }
    return out;
  }

  // ----- Mutations --------------------------------------------------------
  async function handleCreatePerson(fields: PersonFields) {
    if (!treeId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createIndividual(treeId, fieldsToPayload(fields));
      await reload();
      setRootId((r) => r ?? created.id);
      setSelectedId(created.id);
      setModal(null);
      pushUndo(`Add ${displayName(created)}`, () => api.deleteIndividual(treeId, created.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add person");
    } finally {
      setBusy(false);
    }
  }

  async function handleEditPerson(fields: PersonFields) {
    if (!treeId || !selectedId) return;
    const before = personById.get(selectedId);
    setBusy(true);
    setError(null);
    try {
      await api.updateIndividual(treeId, selectedId, fieldsToPayload(fields));
      await reload();
      setModal(null);
      if (before)
        pushUndo(`Edit ${displayName(before)}`, () =>
          api.updateIndividual(treeId, before.id, individualPayload(before))
        );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save changes");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeletePerson() {
    if (!treeId || !selected) return;
    if (!confirm(`Delete ${displayName(selected)}? This also removes their family links.`)) return;
    const person = selected;
    // Capture everything needed to put the person back: their full record, the
    // families they are a parent in, and the families they are a child in.
    const asParent = families.filter(
      (f) => f.husband_id === person.id || f.wife_id === person.id
    );
    const asChild = families
      .filter((f) => f.children.some((c) => c.individual_id === person.id))
      .map((f) => {
        const c = f.children.find((x) => x.individual_id === person.id);
        return { familyId: f.id, birth_order: c?.birth_order ?? null, relation: c?.relation ?? "biological" };
      });
    setBusy(true);
    setError(null);
    try {
      await api.deleteIndividual(treeId, person.id);
      setSelectedId(null);
      await reload();
      pushUndo(`Delete ${displayName(person)}`, async () => {
        const recreated = await api.createIndividual(treeId, individualPayload(person));
        const current = await api.listFamilies(treeId);
        const currentById = new Map(current.map((f) => [f.id, f]));
        for (const fam of asParent) {
          const slot = fam.husband_id === person.id ? "husband_id" : "wife_id";
          if (currentById.has(fam.id)) {
            // The family survived (it had children); just restore the emptied slot.
            await api.updateFamily(treeId, fam.id, { [slot]: recreated.id });
          } else {
            // The family was cleaned up as a ghost; recreate it.
            const other = fam.husband_id === person.id ? fam.wife_id : fam.husband_id;
            await api.createFamily(treeId, {
              husband_id: slot === "husband_id" ? recreated.id : other,
              wife_id: slot === "wife_id" ? recreated.id : other,
              married_date: fam.married_date,
              married_place: fam.married_place,
              divorced_date: fam.divorced_date,
              notes: fam.notes,
              marriage_order: fam.marriage_order,
              children: fam.children,
            });
          }
        }
        for (const link of asChild) {
          const fam = currentById.get(link.familyId);
          if (fam)
            await api.updateFamily(treeId, fam.id, {
              children: [
                ...fam.children.map(childRef),
                { individual_id: recreated.id, birth_order: link.birth_order, relation: link.relation },
              ],
            });
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setBusy(false);
    }
  }

  async function handleAddSpouse(fields: PersonFields) {
    if (!treeId || !selected) return;
    setBusy(true);
    setError(null);
    try {
      const spouse = await api.createIndividual(treeId, fieldsToPayload(fields));
      await api.createFamily(treeId, {
        ...assignSpouseSlots(selected, spouse),
        unmarried: !spouseMarried,
        children: [],
      });
      await reload();
      setModal(null);
      // Deleting the new spouse cascades the marriage away (and the now-empty
      // family is cleaned up server-side).
      pushUndo(`Add spouse ${displayName(spouse)}`, () =>
        api.deleteIndividual(treeId, spouse.id)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add spouse");
    } finally {
      setBusy(false);
    }
  }

  // Marry the selected person to someone ALREADY in the tree (e.g. a relative who
  // is also a spouse). Creates only the marriage family — neither person is new,
  // so undoing just removes that family.
  async function handleLinkExistingSpouse() {
    if (!treeId || !selected || !linkSpouseId) return;
    const other = personById.get(linkSpouseId);
    if (!other) return;
    setBusy(true);
    setError(null);
    try {
      const fam = await api.createFamily(treeId, {
        ...assignSpouseSlots(selected, other),
        unmarried: !spouseMarried,
        children: [],
      });
      await reload();
      setModal(null);
      pushUndo(`Marry ${displayName(selected)} & ${displayName(other)}`, () =>
        api.deleteFamily(treeId, fam.id)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to link spouse");
    } finally {
      setBusy(false);
    }
  }

  function openAddSpouse() {
    setSpouseMode("new");
    setLinkSpouseId("");
    setSpouseMarried(true);
    setModal("addSpouse");
  }

  async function handleAddChild(fields: PersonFields) {
    if (!treeId || !selected) return;
    setBusy(true);
    setError(null);
    try {
      const child = await api.createIndividual(treeId, fieldsToPayload(fields));
      if (childFamilyChoice !== "new") {
        const fam = families.find((f) => f.id === childFamilyChoice);
        if (fam) {
          const existing = fam.children.map(childRef);
          await api.updateFamily(treeId, fam.id, {
            children: [
              ...existing,
              {
                individual_id: child.id,
                birth_order: existing.length + 1,
                relation: childRelation,
              },
            ],
          });
        }
      } else {
        // New single-parent family with the selected person as the parent.
        const slot = selected.sex === "F" ? { wife_id: selected.id } : { husband_id: selected.id };
        await api.createFamily(treeId, {
          ...slot,
          children: [{ individual_id: child.id, birth_order: 1, relation: childRelation }],
        });
      }
      await reload();
      setModal(null);
      // Deleting the child removes its parent link (and a new single-parent
      // family, if one was created, is cleaned up server-side).
      pushUndo(`Add child ${displayName(child)}`, () => api.deleteIndividual(treeId, child.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add child");
    } finally {
      setBusy(false);
    }
  }

  // Add an older-generation person ABOVE the selected one (e.g. when research
  // turns up an earlier ancestor). Links them as a parent and re-roots the view
  // on the new person so they sit at the top.
  async function handleAddParent(fields: PersonFields) {
    if (!treeId || !selected) return;
    const child = selected;
    setBusy(true);
    setError(null);
    try {
      const parent = await api.createIndividual(treeId, fieldsToPayload(fields));
      const childFam = families.find((f) => f.children.some((c) => c.individual_id === child.id));
      const wantSlot = parent.sex === "F" ? "wife_id" : "husband_id";
      const otherSlot = wantSlot === "wife_id" ? "husband_id" : "wife_id";
      let createdFamId: string | null = null;
      if (childFam && (!childFam[wantSlot] || !childFam[otherSlot])) {
        // The child already has a parent-family with a free slot — fill it, so the
        // two parents become a couple over this child.
        const slot = childFam[wantSlot] ? otherSlot : wantSlot;
        await api.updateFamily(treeId, childFam.id, { [slot]: parent.id });
      } else {
        const created = await api.createFamily(treeId, {
          [wantSlot]: parent.id,
          children: [{ individual_id: child.id, birth_order: 1, relation: "biological" }],
        });
        createdFamId = created.id;
      }
      await reload();
      setRootId(parent.id);
      setSelectedId(parent.id);
      setModal(null);
      pushUndo(`Add parent ${displayName(parent)}`, async () => {
        if (createdFamId) await api.deleteFamily(treeId, createdFamId);
        await api.deleteIndividual(treeId, parent.id); // cascades the slot back to NULL
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add parent");
    } finally {
      setBusy(false);
    }
  }

  // Add a known descendant of unknown depth: a person known to descend from the
  // selected one, but with the intervening generations unknown. Stored as a
  // single-parent family flagged `gap` so the connector renders dotted.
  async function handleAddDescendant(fields: PersonFields) {
    if (!treeId || !selected) return;
    setBusy(true);
    setError(null);
    try {
      const desc = await api.createIndividual(treeId, fieldsToPayload(fields));
      const slot = selected.sex === "F" ? { wife_id: selected.id } : { husband_id: selected.id };
      await api.createFamily(treeId, {
        ...slot,
        gap: true,
        children: [{ individual_id: desc.id, birth_order: 1, relation: "biological" }],
      });
      await reload();
      setModal(null);
      pushUndo(`Add descendant ${displayName(desc)}`, () =>
        api.deleteIndividual(treeId, desc.id)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add descendant");
    } finally {
      setBusy(false);
    }
  }

  function openRelate() {
    // Seed with the selected person (if any) plus an empty slot to compare.
    setRelateIds([selected?.id ?? "", ""]);
    setModal("relate");
  }

  // Highlight the relationship path between two people on the chart.
  function showPath(aId: string, bId: string) {
    const path = relationshipPath(aId, bId, families);
    if (path.length > 1) {
      setHighlightIds(new Set(path));
      setModal(null);
    } else {
      setError("No connecting path to highlight between those two people.");
    }
  }

  // The person's marriages, ordered by marriage_order (1st, 2nd, …).
  function orderedMarriages(personId: string) {
    return spouseFamiliesOf(personId).sort(
      (a, b) =>
        (a.family.marriage_order ?? Infinity) - (b.family.marriage_order ?? Infinity) ||
        a.family.id.localeCompare(b.family.id)
    );
  }

  // Move a marriage up/down in order, renumbering all of the person's marriages.
  async function moveMarriage(personId: string, familyId: string, dir: -1 | 1) {
    if (!treeId) return;
    const list = orderedMarriages(personId).map((m) => m.family);
    const idx = list.findIndex((f) => f.id === familyId);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= list.length) return;
    const before = list.map((f) => ({ id: f.id, marriage_order: f.marriage_order }));
    [list[idx], list[swap]] = [list[swap], list[idx]];
    setBusy(true);
    try {
      await Promise.all(
        list.map((f, i) => api.updateFamily(treeId, f.id, { marriage_order: i + 1 }))
      );
      await reload();
      pushUndo("Reorder marriages", () =>
        Promise.all(
          before.map((b) => api.updateFamily(treeId, b.id, { marriage_order: b.marriage_order }))
        ).then(() => undefined)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reorder marriages");
    } finally {
      setBusy(false);
    }
  }

  // ----- Family / marriage editing ----------------------------------------
  function openEditFamily(family: Family) {
    setEditFamilyId(family.id);
    setFamForm({
      married: !family.unmarried,
      married_date: family.married_date ?? "",
      married_place: family.married_place ?? "",
      divorced_date: family.divorced_date ?? "",
    });
    setModal("editFamily");
  }

  const blankToNull = (s: string) => (s.trim() === "" ? null : s.trim());

  async function handleSaveFamily() {
    if (!treeId || !editFamilyId) return;
    const fam = families.find((f) => f.id === editFamilyId);
    if (!fam) return;
    const before = {
      unmarried: fam.unmarried,
      married_date: fam.married_date,
      married_place: fam.married_place,
      divorced_date: fam.divorced_date,
    };
    setBusy(true);
    setError(null);
    try {
      await api.updateFamily(treeId, editFamilyId, {
        unmarried: !famForm.married,
        married_date: blankToNull(famForm.married_date),
        married_place: blankToNull(famForm.married_place),
        divorced_date: blankToNull(famForm.divorced_date),
      });
      await reload();
      setModal(null);
      pushUndo("Edit marriage", () => api.updateFamily(treeId, editFamilyId, before));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save marriage");
    } finally {
      setBusy(false);
    }
  }

  // Remove a partnership. With children, keep them under the OTHER partner (just
  // drop this person from the couple); childless, delete the family outright.
  async function handleRemoveMarriage(family: Family, coParentId: string | null) {
    if (!treeId || !selected) return;
    const label = coParentId
      ? `the marriage of ${displayName(selected)} & ${displayName(personById.get(coParentId))}`
      : "this marriage";
    const hasKids = family.children.length > 0;
    const msg = hasKids
      ? `Remove ${label}? Their ${family.children.length} child(ren) will stay with ${displayName(selected)}.`
      : `Remove ${label}?`;
    if (!confirm(msg)) return;
    const slot = family.husband_id === coParentId ? "husband_id" : "wife_id";
    setBusy(true);
    setError(null);
    try {
      if (hasKids) {
        await api.updateFamily(treeId, family.id, { [slot]: null });
        await reload();
        setModal(null);
        pushUndo("Remove marriage", () =>
          api.updateFamily(treeId, family.id, { [slot]: coParentId })
        );
      } else {
        await api.deleteFamily(treeId, family.id);
        await reload();
        setModal(null);
        pushUndo("Remove marriage", () =>
          api.createFamily(treeId, {
            husband_id: family.husband_id,
            wife_id: family.wife_id,
            married_date: family.married_date,
            married_place: family.married_place,
            divorced_date: family.divorced_date,
            marriage_order: family.marriage_order,
            unmarried: family.unmarried,
            children: [],
          })
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove marriage");
    } finally {
      setBusy(false);
    }
  }

  // Reorder a child within its family (renumbers birth_order).
  async function moveChild(family: Family, childId: string, dir: -1 | 1) {
    if (!treeId) return;
    const list = [...family.children].sort(
      (a, b) => (a.birth_order ?? Infinity) - (b.birth_order ?? Infinity)
    );
    const idx = list.findIndex((c) => c.individual_id === childId);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= list.length) return;
    [list[idx], list[swap]] = [list[swap], list[idx]];
    setBusy(true);
    try {
      await api.updateFamily(treeId, family.id, {
        children: list.map((c, i) => ({ ...childRef(c), birth_order: i + 1 })),
      });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reorder children");
    } finally {
      setBusy(false);
    }
  }

  // Order a family's children oldest-first by birth date. Children with no
  // parseable birth year keep their current relative order and sort to the end.
  async function sortChildrenByBirth(family: Family) {
    if (!treeId) return;
    const current = [...family.children].sort(
      (a, b) => (a.birth_order ?? Infinity) - (b.birth_order ?? Infinity)
    );
    const withPos = current.map((c, i) => ({
      c,
      pos: i,
      year: birthYear(personById.get(c.individual_id)?.birth_date ?? null),
    }));
    withPos.sort((a, b) => {
      if (a.year === null && b.year === null) return a.pos - b.pos;
      if (a.year === null) return 1;
      if (b.year === null) return -1;
      return a.year - b.year; // oldest (earliest / most-negative BC) first
    });
    setBusy(true);
    try {
      await api.updateFamily(treeId, family.id, {
        children: withPos.map((w, i) => ({ ...childRef(w.c), birth_order: i + 1 })),
      });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sort children");
    } finally {
      setBusy(false);
    }
  }

  // Detach a child from a family (removes the parent link; the person stays).
  async function detachChild(family: Family, childId: string) {
    if (!treeId) return;
    const child = personById.get(childId);
    if (!confirm(`Remove ${displayName(child)} as a child of this family? The person is kept.`)) return;
    const before = family.children.map(childRef);
    setBusy(true);
    try {
      await api.updateFamily(treeId, family.id, {
        children: before.filter((c) => c.individual_id !== childId),
      });
      await reload();
      pushUndo(`Detach ${displayName(child)}`, () =>
        api.updateFamily(treeId, family.id, { children: before })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to detach child");
    } finally {
      setBusy(false);
    }
  }

  // Change a child's relationship type (biological/adopted/step/foster) in a family.
  async function setChildRelationship(family: Family, childId: string, relation: string) {
    if (!treeId) return;
    setBusy(true);
    try {
      await api.updateFamily(treeId, family.id, {
        children: family.children.map((c) =>
          c.individual_id === childId ? { ...childRef(c), relation } : childRef(c)
        ),
      });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update child relationship");
    } finally {
      setBusy(false);
    }
  }

  async function handleImport(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !treeId) return;
    setImporting(true);
    setError(null);
    setSummary(null);
    try {
      const result = await api.importGedcom(treeId, file);
      setSummary(result);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
      e.target.value = "";
    }
  }

  const sortedIndividuals = useMemo(
    () => [...individuals].sort((a, b) => displayName(a).localeCompare(displayName(b))),
    [individuals]
  );

  // People who have at least one parent recorded — used to offer "expand
  // ancestry" on a married-in spouse box.
  const peopleWithParents = useMemo(() => {
    const ids = new Set<string>();
    for (const f of families) {
      if (!f.husband_id && !f.wife_id) continue;
      for (const c of f.children) ids.add(c.individual_id);
    }
    return ids;
  }, [families]);

  // Drop any expanded spouse-ancestry when switching trees.
  useEffect(() => {
    setExpandedFamily({});
  }, [treeId]);

  // Walk up from a person via their parents (preferring the father) to the
  // topmost ancestor, returning the path [person, parent, …, topmost].
  function ancestorPathTo(personId: string): string[] {
    const path = [personId];
    const seen = new Set(path);
    let cur = personId;
    for (;;) {
      const fam = families.find(
        (f) => (f.husband_id || f.wife_id) && f.children.some((c) => c.individual_id === cur)
      );
      if (!fam) break;
      const parent = fam.husband_id ?? fam.wife_id;
      if (!parent || seen.has(parent)) break;
      path.push(parent);
      seen.add(parent);
      cur = parent;
    }
    return path;
  }

  // Toggle the family-of-origin expansion above a married-in spouse. On expand
  // we fetch the descendant tree of their topmost ancestor and prune it to the
  // direct line + each ancestor's other children (siblings/aunts/uncles), cutting
  // the spouse's OWN descendants (already shown in the main tree).
  async function handleToggleAncestry(spouseId: string) {
    if (!treeId) return;
    if (expandedFamily[spouseId]) {
      setExpandedFamily((m) => {
        const next = { ...m };
        delete next[spouseId];
        return next;
      });
      return;
    }
    const path = ancestorPathTo(spouseId);
    if (path.length < 2) return;
    const onPath = new Set(path);
    const prune = (node: TreeNode) => {
      if (node.id === spouseId || !onPath.has(node.id)) {
        node.unions = [];
        return;
      }
      for (const u of node.unions) {
        if (u.spouse) prune(u.spouse);
        for (const c of u.children) prune(c);
      }
    };
    try {
      const tree = await api.descendants(treeId, path[path.length - 1]);
      prune(tree);
      setExpandedFamily((m) => ({ ...m, [spouseId]: tree }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load family");
    }
  }

  // Data-integrity warnings, split into active and user-dismissed ("reviewed, it's fine").
  const allWarnings = useMemo(() => findWarnings(individuals, families), [individuals, families]);
  const warnings = useMemo(
    () => allWarnings.filter((w) => !dismissedWarningKeys.has(w.key)),
    [allWarnings, dismissedWarningKeys]
  );
  const dismissedWarnings = useMemo(
    () => allWarnings.filter((w) => dismissedWarningKeys.has(w.key)),
    [allWarnings, dismissedWarningKeys]
  );

  // Load the dismissed-warning keys for this tree.
  useEffect(() => {
    if (!treeId) return;
    let cancelled = false;
    api
      .listDismissedWarnings(treeId)
      .then((keys) => !cancelled && setDismissedWarningKeys(new Set(keys)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [treeId]);

  async function handleDismissWarning(key: string) {
    if (!treeId) return;
    setDismissedWarningKeys((s) => new Set(s).add(key));
    try {
      await api.dismissWarning(treeId, key);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to dismiss");
    }
  }

  async function handleRestoreWarning(key: string) {
    if (!treeId) return;
    setDismissedWarningKeys((s) => {
      const next = new Set(s);
      next.delete(key);
      return next;
    });
    try {
      await api.undismissWarning(treeId, key);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to restore");
    }
  }

  // Candidate duplicates, minus pairs already dismissed as "not a duplicate".
  const allDuplicates = useMemo(() => findDuplicates(individuals), [individuals]);
  const duplicates = useMemo(
    () => allDuplicates.filter((p) => !dismissedPairs.has(pairKey(p.a.id, p.b.id))),
    [allDuplicates, dismissedPairs]
  );
  const dismissedDuplicates = useMemo(
    () => allDuplicates.filter((p) => dismissedPairs.has(pairKey(p.a.id, p.b.id))),
    [allDuplicates, dismissedPairs]
  );

  // Load the dismissed-duplicate pairs for this tree.
  useEffect(() => {
    if (!treeId) return;
    let cancelled = false;
    api
      .listDismissedDuplicates(treeId)
      .then((pairs) => {
        if (!cancelled)
          setDismissedPairs(new Set(pairs.map((p) => pairKey(p.individual_a, p.individual_b))));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [treeId]);

  async function handleDismissDuplicate(idA: string, idB: string) {
    if (!treeId) return;
    setDismissedPairs((s) => new Set(s).add(pairKey(idA, idB)));
    try {
      await api.dismissDuplicate(treeId, idA, idB);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to dismiss");
    }
  }

  async function handleRestoreDuplicate(idA: string, idB: string) {
    if (!treeId) return;
    setDismissedPairs((s) => {
      const next = new Set(s);
      next.delete(pairKey(idA, idB));
      return next;
    });
    try {
      await api.undismissDuplicate(treeId, idA, idB);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to restore");
    }
  }

  // Search matches over name, dates, places, and age (first 15).
  const searchMatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return sortedIndividuals
      .filter((p) =>
        [
          displayName(p),
          p.surname,
          p.married_name,
          p.birth_date,
          p.birth_place,
          p.death_date,
          p.death_place,
          p.age,
        ]
          .filter(Boolean)
          .some((s) => s!.toLowerCase().includes(q))
      )
      .slice(0, 15);
  }, [search, sortedIndividuals]);

  function goToPerson(id: string) {
    handleSelect(id);
    setSearch("");
  }

  function openAddChild() {
    const fams = selected ? spouseFamiliesOf(selected.id) : [];
    setChildFamilyChoice(fams.length > 0 ? fams[0].family.id : "new");
    setChildRelation("biological");
    setModal("addChild");
  }

  // Add a child straight to a couple (from the chart "+" on a spouse box).
  function addChildToCouple(aId: string, bId: string) {
    const fam = families.find(
      (f) =>
        (f.husband_id === aId && f.wife_id === bId) ||
        (f.husband_id === bId && f.wife_id === aId)
    );
    if (!fam) return;
    setSelectedId(aId);
    setChildFamilyChoice(fam.id);
    setModal("addChild");
  }

  // Stable identities for the chart callbacks (see useStableCallback) — these go
  // into the chart effects' dependency arrays.
  const onChartSelect = useStableCallback(handleSelect);
  const onChartAddChild = useStableCallback(addChildToCouple);
  const onChartToggleAncestry = useStableCallback(handleToggleAncestry);

  // "Husband ♂ + Wife ♀" label for the couple-picker, with unknown/empty slots.
  function coupleLabel(family: Family): string {
    const h = family.husband_id ? personById.get(family.husband_id) ?? null : null;
    const w = family.wife_id ? personById.get(family.wife_id) ?? null : null;
    const part = (p: Individual | null, glyph: string) =>
      p ? `${displayName(p)} ${glyph}` : `(no partner)`;
    return `${part(h, "♂")}  +  ${part(w, "♀")}`;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-gray-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-800">
        <Link to="/" className="text-sm font-medium text-brand hover:underline dark:text-brand-soft">
          ← Trees
        </Link>
        {individuals.length > 0 && (
          <div className="flex items-center gap-2">
            <div className="relative">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setSearch("");
                  if (e.key === "Enter" && searchMatches[0]) goToPerson(searchMatches[0].id);
                }}
                placeholder="🔍 Find a person…"
                className="w-44 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-brand focus:outline-none dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
              />
              {search.trim() && (
                <ul className="absolute z-30 mt-1 max-h-72 w-64 overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-slate-600 dark:bg-slate-800">
                  {searchMatches.length === 0 ? (
                    <li className="px-3 py-2 text-sm text-gray-400 dark:text-slate-500">No matches</li>
                  ) : (
                    searchMatches.map((p) => (
                      <li key={p.id}>
                        <button
                          onMouseDown={() => goToPerson(p.id)}
                          className="block w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-slate-700"
                        >
                          <span className="text-gray-800 dark:text-slate-100">{displayName(p)}</span>
                          {(p.birth_date || p.death_date || p.age) && (
                            <span className="ml-2 text-xs text-gray-400 dark:text-slate-500">
                              {[p.birth_date, p.death_date].filter(Boolean).join("–") || p.age}
                            </span>
                          )}
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </div>
            <button
              onClick={() => rootParentId && setRootId(rootParentId)}
              disabled={!rootParentId}
              title={rootParentId ? "Show this person's parent (up a level)" : "Already at the top of the tree"}
              className="rounded-lg border border-gray-300 dark:border-slate-600 px-2.5 py-1.5 text-sm font-medium text-gray-700 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-40"
            >
              ▲ Up
            </button>
            <button
              onClick={showWholeTree}
              title="Show the whole tree (top ancestor)"
              className="rounded-lg border border-gray-300 dark:border-slate-600 px-2.5 py-1.5 text-sm font-medium text-gray-700 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-700"
            >
              ⌂ Whole tree
            </button>
            <label className="text-sm font-medium text-gray-600 dark:text-slate-300">Root person</label>
            <select
              value={rootId ?? ""}
              onChange={(e) => setRootId(e.target.value || null)}
              className="rounded-lg border border-gray-300 dark:border-slate-600 px-3 py-1.5 text-sm focus:border-brand focus:outline-none dark:bg-slate-700 dark:text-slate-100"
            >
              {sortedIndividuals.map((indi) => (
                <option key={indi.id} value={indi.id}>
                  {displayName(indi)}
                </option>
              ))}
            </select>
            <div
              className="flex rounded-lg bg-gray-100 p-0.5 text-xs font-medium dark:bg-slate-700"
              title="Show descendants (down) or ancestors (up)"
            >
              {(
                [
                  ["descendants", "↓ Descendants"],
                  ["ancestors", "↑ Ancestors"],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  onClick={() => setViewMode(m)}
                  className={`rounded-md px-2 py-1 ${
                    viewMode === m
                      ? "bg-white text-brand shadow dark:bg-slate-900 dark:text-brand-soft"
                      : "text-gray-500 dark:text-slate-400"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {viewMode === "descendants" && (
              <>
                <label
                  className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-slate-300"
                  title="Show a married-in spouse's other marriages (step-relations)"
                >
                  <input
                    type="checkbox"
                    checked={showConverging}
                    onChange={(e) => setShowConverging(e.target.checked)}
                  />
                  Step-relations
                </label>
                <label
                  className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-slate-300"
                  title="How hovering magnifies a zoomed-out tree"
                >
                  Magnify
                  <select
                    value={magnify}
                    onChange={(e) => setMagnify(e.target.value as MagnifyMode)}
                    className="rounded-lg border border-gray-300 dark:border-slate-600 px-2 py-1.5 text-sm focus:border-brand focus:outline-none dark:bg-slate-700 dark:text-slate-100"
                  >
                    <option value="loupe">Loupe</option>
                    <option value="bulge">Bulge</option>
                    <option value="off">Off</option>
                  </select>
                </label>
                <button
                  onClick={toggleOrientation}
                  title="Switch between top-down and left-to-right layout (remembered for this tree)"
                  className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
                >
                  {orientation === "vertical" ? "⬇ Top-down" : "➡ Left-right"}
                </button>
              </>
            )}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {(duplicates.length > 0 || dismissedDuplicates.length > 0) && (
            <button
              onClick={() => setModal("duplicates")}
              title={
                duplicates.length > 0
                  ? `${duplicates.length} possible duplicate(s)`
                  : "Review dismissed duplicates"
              }
              className={`rounded-lg border px-2.5 py-1.5 text-sm font-medium ${
                duplicates.length > 0
                  ? "border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                  : "border-gray-200 text-gray-400 hover:bg-gray-100 dark:border-slate-700 dark:text-slate-500 dark:hover:bg-slate-700"
              }`}
            >
              ⧉ {duplicates.length > 0 ? duplicates.length : ""}
            </button>
          )}
          {(warnings.length > 0 || dismissedWarnings.length > 0) && (
            <button
              onClick={() => setModal("warnings")}
              title={
                warnings.length > 0
                  ? `${warnings.length} possible data issue(s)`
                  : "Review dismissed data issues"
              }
              className={`rounded-lg border px-2.5 py-1.5 text-sm font-medium ${
                warnings.length > 0
                  ? "border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/40"
                  : "border-gray-200 text-gray-400 hover:bg-gray-100 dark:border-slate-700 dark:text-slate-500 dark:hover:bg-slate-700"
              }`}
            >
              ⚠ {warnings.length > 0 ? warnings.length : ""}
            </button>
          )}
          <ThemeToggle />
          <button
            onClick={handleUndo}
            disabled={undoStack.length === 0 || busy}
            title={
              undoStack.length > 0
                ? `Undo: ${undoStack[undoStack.length - 1].label}`
                : "Nothing to undo"
            }
            className="rounded-lg border border-gray-300 dark:border-slate-600 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-40"
          >
            ↶ Undo
          </button>
          <button
            onClick={() => setModal("add")}
            className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-light"
          >
            + Add person
          </button>
          <label className="cursor-pointer rounded-lg border border-gray-300 dark:border-slate-600 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-700">
            {importing ? "Importing…" : "Import GEDCOM"}
            <input
              type="file"
              accept=".ged,.gedcom,text/plain"
              onChange={handleImport}
              disabled={importing}
              className="hidden"
            />
          </label>
          {individuals.length > 0 && (
            <button
              onClick={handleExportImage}
              title="Download the current chart as a PNG image"
              className="rounded-lg border border-gray-300 dark:border-slate-600 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-700"
            >
              Export image
            </button>
          )}
          {treeId && individuals.length > 0 && (
            <a
              href={api.exportUrl(treeId)}
              className="rounded-lg border border-gray-300 dark:border-slate-600 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-700"
            >
              Export GEDCOM
            </a>
          )}
        </div>
      </header>

      {error && (
        <p className="bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
          {error}
        </p>
      )}
      {summary && (
        <div className="bg-green-50 px-4 py-2 text-sm text-green-800 dark:bg-green-950/50 dark:text-green-300">
          Imported {summary.individuals_imported} individuals, {summary.families_imported} families,{" "}
          {summary.children_links} parent-child links
          {summary.unknown_spouses_created > 0 &&
            `, created ${summary.unknown_spouses_created} unknown spouse placeholder(s)`}
          .{summary.warnings.length > 0 && ` ${summary.warnings.length} warning(s).`}
        </div>
      )}
      {highlightIds && (
        <div className="flex items-center gap-3 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <span>⚭ Highlighting the relationship path ({highlightIds.size} people).</span>
          <button
            onClick={() => setHighlightIds(null)}
            className="font-medium underline hover:no-underline"
          >
            Clear
          </button>
        </div>
      )}

      <main className="flex flex-1 overflow-hidden bg-slate-50 dark:bg-slate-900">
        <div className="relative min-w-0 flex-1">
        {loading ? (
          <Centered>Loading…</Centered>
        ) : individuals.length === 0 ? (
          <Centered>
            <div className="max-w-sm text-center">
              <h2 className="mb-2 text-lg font-semibold text-gray-700 dark:text-slate-200">Start your family tree</h2>
              <p className="mb-5 text-sm text-gray-500 dark:text-slate-400">
                Add the first person to begin, then add their spouses and children. Already have a
                GEDCOM file? Import it instead.
              </p>
              <button
                onClick={() => setModal("add")}
                className="rounded-lg bg-brand px-5 py-2.5 font-medium text-white hover:bg-brand-light"
              >
                + Add the first person
              </button>
            </div>
          </Centered>
        ) : viewMode === "ancestors" ? (
          ancestorData ? (
            <AncestorChart
              root={ancestorData}
              onSelect={onChartSelect}
              theme={theme}
              highlightIds={highlightIds ?? undefined}
            />
          ) : (
            <Centered>Building chart…</Centered>
          )
        ) : treeData ? (
          <DescendantPyramid
            root={treeData}
            onSelect={onChartSelect}
            showConverging={showConverging}
            magnify={magnify}
            onAddChild={onChartAddChild}
            theme={theme}
            highlightIds={highlightIds ?? undefined}
            spousesWithParents={peopleWithParents}
            expandedFamily={expandedFamily}
            onToggleAncestry={onChartToggleAncestry}
            orientation={orientation}
          />
        ) : (
          <Centered>Building chart…</Centered>
        )}

        {(viewMode === "ancestors" ? ancestorData : treeData) && (
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-white/80 px-3 py-1.5 text-xs text-gray-500 shadow dark:bg-slate-800/80 dark:text-slate-400">
            {viewMode === "ancestors"
              ? "Ancestors fan upward · drag to pan · click a person to centre on them"
              : "Scroll to zoom · drag to pan · hover to magnify · click a person to focus their branch"}
          </div>
        )}
        </div>

        {/* Detail / relations panel — docks beside the tree so it never covers it. */}
        {selected && (
          <aside className="w-72 shrink-0 overflow-y-auto border-l border-gray-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
            <div className="mb-2 flex items-start justify-between">
              <div className="flex items-center gap-2">
                {selected.photo_url && (
                  <img
                    src={selected.photo_url}
                    alt=""
                    className="h-10 w-10 rounded-full object-cover ring-1 ring-gray-200 dark:ring-slate-600"
                  />
                )}
                <h3 className="font-semibold text-gray-800 dark:text-slate-100">{displayName(selected)}</h3>
              </div>
              <button
                onClick={() => setSelectedId(null)}
                className="text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:text-slate-300"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <dl className="mb-4 space-y-1 text-sm text-gray-600 dark:text-slate-300">
              {selected.married_name && selected.surname && selected.married_name !== selected.surname && (
                <Detail label="née" value={selected.surname} />
              )}
              <Detail label="Sex" value={sexLabel(selected.sex)} />
              <Detail label="Born" value={joinDatePlace(selected.birth_date, selected.birth_place)} />
              <Detail label="Died" value={joinDatePlace(selected.death_date, selected.death_place)} />
              <Detail label="Age" value={selected.age} />
              <Detail label="Notes" value={selected.notes} wrap />
              {selected.is_unknown && (
                <p className="italic text-gray-400 dark:text-slate-500">Placeholder (unknown) individual</p>
              )}
            </dl>

            {(() => {
              const parents = parentsOf(selected.id);
              // Include single-parent families that have children (no co-parent
              // recorded) so their child links stay editable — e.g. changing a
              // child's relation to adopted. Empty partnerless "ghost" families
              // (no co-parent AND no children) are still hidden.
              const partners = orderedMarriages(selected.id).filter(
                (m) => m.coParent || m.family.children.length > 0
              );
              const kids = childrenOf(selected.id);
              if (!parents.length && !partners.length && !kids.length) return null;
              return (
                <div className="mb-4 space-y-3 border-t border-gray-100 pt-3 text-sm dark:border-slate-700">
                  {parents.length > 0 && (
                    <Relatives label="Parents" people={parents} onPick={handleSelect} />
                  )}
                  {partners.length > 0 && (
                    <div>
                      <p className="mb-1 text-xs font-medium text-gray-500 dark:text-slate-400">
                        {partners.length > 1 ? "Partners (order)" : "Partner"}
                      </p>
                      <ul className="space-y-1.5">
                        {partners.map(({ family, coParent }, i, arr) => (
                          <li key={family.id} className="flex items-start gap-1.5">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                {coParent ? (
                                  <>
                                    <RelativeLink person={coParent} onPick={handleSelect} />
                                    <StatusBadge family={family} />
                                  </>
                                ) : (
                                  <span className="italic text-gray-500 dark:text-slate-400">
                                    (no other parent)
                                  </span>
                                )}
                              </div>
                              {marriageDates(family) && (
                                <div className="text-xs text-gray-400 dark:text-slate-500">
                                  {marriageDates(family)}
                                </div>
                              )}
                            </div>
                            <span className="flex shrink-0 items-center">
                              <button
                                onClick={() => openEditFamily(family)}
                                className="px-1 text-gray-400 hover:text-brand disabled:opacity-30 dark:text-slate-500 dark:hover:text-brand-soft"
                                title="Edit this marriage"
                              >
                                ✎
                              </button>
                              {arr.length > 1 && (
                                <>
                                  <button
                                    onClick={() => moveMarriage(selected.id, family.id, -1)}
                                    disabled={i === 0 || busy}
                                    className="px-1 text-gray-400 hover:text-gray-700 disabled:opacity-30 dark:text-slate-500 dark:hover:text-slate-200"
                                    title="Move earlier"
                                  >
                                    ▲
                                  </button>
                                  <button
                                    onClick={() => moveMarriage(selected.id, family.id, 1)}
                                    disabled={i === arr.length - 1 || busy}
                                    className="px-1 text-gray-400 hover:text-gray-700 disabled:opacity-30 dark:text-slate-500 dark:hover:text-slate-200"
                                    title="Move later"
                                  >
                                    ▼
                                  </button>
                                </>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {kids.length > 0 && (
                    <Relatives label="Children" people={kids} onPick={handleSelect} />
                  )}
                </div>
              );
            })()}

            <div className="grid grid-cols-2 gap-2 text-sm">
              <PanelButton onClick={() => setModal("addParent")}>▲ Add parent</PanelButton>
              <PanelButton onClick={openAddSpouse}>Add spouse</PanelButton>
              <PanelButton onClick={openAddChild}>Add child</PanelButton>
              <PanelButton
                onClick={() => setModal("addDescendant")}
                title="Add a known descendant when the generations between are unknown"
              >
                Add descendant
              </PanelButton>
              <PanelButton onClick={() => setModal("edit")}>Edit</PanelButton>
              <PanelButton onClick={openRelate}>Relationship…</PanelButton>
              <PanelButton onClick={showWholeTree} className="col-span-2">
                ⌂ Whole tree
              </PanelButton>
              <button
                onClick={handleDeletePerson}
                disabled={busy}
                className="col-span-2 rounded-lg border border-red-200 px-3 py-1.5 font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                Delete
              </button>
            </div>
          </aside>
        )}
      </main>

      {/* Modals */}
      {modal === "add" && (
        <Modal title="Add person" onClose={() => setModal(null)}>
          <PersonForm submitLabel="Add person" busy={busy} onSubmit={handleCreatePerson} />
        </Modal>
      )}
      {modal === "edit" && selected && (
        <Modal title={`Edit ${displayName(selected)}`} onClose={() => setModal(null)}>
          <PersonForm
            initial={selected}
            submitLabel="Save changes"
            busy={busy}
            onSubmit={handleEditPerson}
          />
        </Modal>
      )}
      {modal === "addSpouse" && selected && (
        <Modal title={`Add spouse of ${displayName(selected)}`} onClose={() => setModal(null)}>
          <div className="mb-4 flex rounded-lg bg-gray-100 p-1 text-sm font-medium dark:bg-slate-700">
            {(
              [
                ["new", "New person"],
                ["existing", "Someone in the tree"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => setSpouseMode(m)}
                className={`flex-1 rounded-md py-1.5 ${
                  spouseMode === m
                    ? "bg-white text-brand shadow dark:bg-slate-900 dark:text-brand-soft"
                    : "text-gray-500 dark:text-slate-400"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <label
            className="mb-4 flex items-center gap-2 text-sm text-gray-700 dark:text-slate-200"
            title="Uncheck for known co-parents who were never married (shown as a dotted link, no marriage symbol)"
          >
            <input
              type="checkbox"
              checked={spouseMarried}
              onChange={(e) => setSpouseMarried(e.target.checked)}
            />
            Married
            <span className="text-xs text-gray-400 dark:text-slate-500">
              (uncheck for unmarried co-parents)
            </span>
          </label>
          {spouseMode === "new" ? (
            <PersonForm
              submitLabel={spouseMarried ? "Add spouse" : "Add co-parent"}
              busy={busy}
              onSubmit={handleAddSpouse}
            />
          ) : (
            <>
              <p className="mb-3 text-sm text-gray-500 dark:text-slate-400">
                Link {displayName(selected)} to someone already in this tree — useful when the two
                are also related another way (e.g. cousins who marry).
              </p>
              <label className="mb-4 block">
                <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300">
                  Spouse
                </span>
                <select
                  value={linkSpouseId}
                  onChange={(e) => setLinkSpouseId(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
                >
                  <option value="">— choose a person —</option>
                  {sortedIndividuals
                    .filter(
                      (i) =>
                        i.id !== selected.id &&
                        !spouseFamiliesOf(selected.id).some((sf) => sf.coParent?.id === i.id)
                    )
                    .map((i) => (
                      <option key={i.id} value={i.id}>
                        {displayName(i)}
                      </option>
                    ))}
                </select>
              </label>
              <button
                onClick={handleLinkExistingSpouse}
                disabled={!linkSpouseId || busy}
                className="w-full rounded-lg bg-brand py-2.5 font-medium text-white hover:bg-brand-light disabled:opacity-50"
              >
                {busy ? "Linking…" : spouseMarried ? "Link as spouse" : "Link as co-parent"}
              </button>
            </>
          )}
        </Modal>
      )}
      {modal === "addParent" && selected && (
        <Modal title={`Add parent of ${displayName(selected)}`} onClose={() => setModal(null)}>
          <p className="mb-3 text-sm text-gray-500 dark:text-slate-400">
            Adds an older-generation person above {displayName(selected)} and re-roots the view on
            them. Set the sex to place them as father or mother; add the other parent the same way.
          </p>
          <PersonForm submitLabel="Add parent" busy={busy} onSubmit={handleAddParent} />
        </Modal>
      )}
      {modal === "addChild" && selected && (
        <Modal title={`Add child of ${displayName(selected)}`} onClose={() => setModal(null)}>
          {spouseFamiliesOf(selected.id).length > 0 && (
            <label className="mb-3 block">
              <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300">
                Which couple are the parents?
              </span>
              <select
                value={childFamilyChoice}
                onChange={(e) => setChildFamilyChoice(e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-slate-600 px-3 py-2 text-sm focus:border-brand focus:outline-none dark:bg-slate-700 dark:text-slate-100"
              >
                {orderedMarriages(selected.id).map(({ family }) => (
                  <option key={family.id} value={family.id}>
                    {coupleLabel(family)}
                  </option>
                ))}
                <option value="new">New co-parent / single parent…</option>
              </select>
            </label>
          )}
          <label className="mb-3 block">
            <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300">
              Relationship to parents
            </span>
            <select
              value={childRelation}
              onChange={(e) => setChildRelation(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            >
              <option value="biological">Biological</option>
              <option value="adopted">Adopted</option>
              <option value="step">Step</option>
              <option value="foster">Foster</option>
            </select>
          </label>
          <PersonForm submitLabel="Add child" busy={busy} onSubmit={handleAddChild} />
        </Modal>
      )}
      {modal === "addDescendant" && selected && (
        <Modal title={`Add descendant of ${displayName(selected)}`} onClose={() => setModal(null)}>
          <p className="mb-3 text-sm text-gray-500 dark:text-slate-400">
            Use this when you know someone descends from {displayName(selected)} but not the
            generations in between. They'll be connected by a <strong>dotted line</strong> to show
            the lineage is incomplete.
          </p>
          <PersonForm submitLabel="Add descendant" busy={busy} onSubmit={handleAddDescendant} />
        </Modal>
      )}
      {modal === "editFamily" &&
        editFamilyId &&
        (() => {
          const fam = families.find((f) => f.id === editFamilyId);
          if (!fam || !selected) return null;
          const coParentId = fam.husband_id === selected.id ? fam.wife_id : fam.husband_id;
          const coParent = coParentId ? personById.get(coParentId) ?? null : null;
          const kids = [...fam.children].sort(
            (a, b) => (a.birth_order ?? Infinity) - (b.birth_order ?? Infinity)
          );
          const fieldCls =
            "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100";
          const setF = (patch: Partial<FamilyForm>) => setFamForm((f) => ({ ...f, ...patch }));
          return (
            <Modal
              title={`${displayName(selected)} & ${coParent ? displayName(coParent) : "unknown partner"}`}
              onClose={() => setModal(null)}
            >
              <div className="space-y-3 text-sm">
                <label className="flex items-center gap-2 text-gray-700 dark:text-slate-200">
                  <input
                    type="checkbox"
                    checked={famForm.married}
                    onChange={(e) => setF({ married: e.target.checked })}
                  />
                  Married
                  <span className="text-xs text-gray-400 dark:text-slate-500">
                    (uncheck for unmarried co-parents)
                  </span>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300">
                      Married date
                    </span>
                    <input
                      value={famForm.married_date}
                      onChange={(e) => setF({ married_date: e.target.value })}
                      placeholder="e.g. 1850 or ABT 1850"
                      className={fieldCls}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300">
                      Married place
                    </span>
                    <input
                      value={famForm.married_place}
                      onChange={(e) => setF({ married_place: e.target.value })}
                      className={fieldCls}
                    />
                  </label>
                </div>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300">
                    Divorced date <span className="text-gray-400">(if applicable)</span>
                  </span>
                  <input
                    value={famForm.divorced_date}
                    onChange={(e) => setF({ divorced_date: e.target.value })}
                    className={fieldCls}
                  />
                </label>

                {kids.length > 0 && (
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <p className="text-xs font-medium text-gray-600 dark:text-slate-300">
                        Children (birth order — oldest first)
                      </p>
                      {kids.length > 1 && (
                        <button
                          onClick={() => sortChildrenByBirth(fam)}
                          disabled={busy}
                          className="text-xs text-brand hover:underline disabled:opacity-40 dark:text-brand-soft"
                          title="Reorder oldest-first using each child's birth date"
                        >
                          Sort by birth date
                        </button>
                      )}
                    </div>
                    <ul className="space-y-1">
                      {kids.map((c, i) => (
                        <li key={c.individual_id} className="flex items-center gap-1.5">
                          <span className="w-5 shrink-0 text-right text-gray-400 dark:text-slate-500">
                            {i + 1}.
                          </span>
                          <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-slate-200">
                            {displayName(personById.get(c.individual_id))}
                          </span>
                          <select
                            value={c.relation}
                            onChange={(e) => setChildRelationship(fam, c.individual_id, e.target.value)}
                            disabled={busy}
                            className="shrink-0 rounded border border-gray-300 bg-transparent px-1 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200"
                            title="Relationship to parents"
                          >
                            <option value="biological">bio</option>
                            <option value="adopted">adopted</option>
                            <option value="step">step</option>
                            <option value="foster">foster</option>
                          </select>
                          <button
                            onClick={() => moveChild(fam, c.individual_id, -1)}
                            disabled={i === 0 || busy}
                            className="px-1 text-gray-400 hover:text-gray-700 disabled:opacity-30 dark:text-slate-500 dark:hover:text-slate-200"
                            title="Move earlier"
                          >
                            ▲
                          </button>
                          <button
                            onClick={() => moveChild(fam, c.individual_id, 1)}
                            disabled={i === kids.length - 1 || busy}
                            className="px-1 text-gray-400 hover:text-gray-700 disabled:opacity-30 dark:text-slate-500 dark:hover:text-slate-200"
                            title="Move later"
                          >
                            ▼
                          </button>
                          <button
                            onClick={() => detachChild(fam, c.individual_id)}
                            disabled={busy}
                            className="px-1 text-gray-400 hover:text-red-600 disabled:opacity-30 dark:text-slate-500 dark:hover:text-red-400"
                            title="Remove from this family (keeps the person)"
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => handleRemoveMarriage(fam, coParentId)}
                    disabled={busy}
                    className="rounded-lg border border-red-200 px-3 py-2 font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                  >
                    Remove marriage
                  </button>
                  <button
                    onClick={handleSaveFamily}
                    disabled={busy}
                    className="ml-auto rounded-lg bg-brand px-5 py-2 font-medium text-white hover:bg-brand-light disabled:opacity-50"
                  >
                    {busy ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            </Modal>
          );
        })()}
      {modal === "relate" && (
        <Modal title="Relationship" onClose={() => setModal(null)}>
          <RelationshipPanel
            ids={relateIds}
            setIds={setRelateIds}
            people={sortedIndividuals}
            byId={personById}
            families={families}
            onShowPath={showPath}
          />
        </Modal>
      )}
      {modal === "warnings" && (
        <Modal title={`Possible data issues (${warnings.length})`} onClose={() => setModal(null)}>
          <p className="mb-3 text-xs text-gray-500 dark:text-slate-400">
            These are heuristic checks (dates are free text, so some may be false alarms).
          </p>
          {warnings.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-slate-400">No issues to review.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {warnings.map((w) => (
                <li
                  key={w.key}
                  className="rounded-lg border border-amber-200 bg-amber-50 p-2 dark:border-amber-900/60 dark:bg-amber-950/30"
                >
                  <p className="text-amber-800 dark:text-amber-200">{w.message}</p>
                  <div className="mt-1 flex gap-3">
                    {w.personId && (
                      <button
                        onClick={() => {
                          handleSelect(w.personId!);
                          setModal(null);
                        }}
                        className="text-xs text-brand hover:underline dark:text-brand-soft"
                      >
                        ↗ Go to person
                      </button>
                    )}
                    <button
                      onClick={() => handleDismissWarning(w.key)}
                      title="I've reviewed this — stop flagging it"
                      className="text-xs text-gray-500 hover:underline dark:text-slate-400"
                    >
                      Dismiss
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {dismissedWarnings.length > 0 && (
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer text-xs font-medium text-gray-500 dark:text-slate-400">
                Dismissed ({dismissedWarnings.length}) — reviewed and accepted
              </summary>
              <ul className="mt-2 space-y-2">
                {dismissedWarnings.map((w) => (
                  <li key={w.key} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-gray-500 dark:text-slate-400">
                      {w.message}
                    </span>
                    <button
                      onClick={() => handleRestoreWarning(w.key)}
                      className="shrink-0 text-xs text-brand hover:underline dark:text-brand-soft"
                    >
                      Re-flag
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Modal>
      )}
      {modal === "duplicates" && (
        <Modal title={`Possible duplicates (${duplicates.length})`} onClose={() => setModal(null)}>
          <p className="mb-3 text-xs text-gray-500 dark:text-slate-400">
            Same name with a matching (or unknown) birth year. Merging moves all of one person's
            relationships onto the other and deletes the duplicate.
          </p>
          {duplicates.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-slate-400">No duplicates to review.</p>
          ) : (
            <ul className="space-y-3 text-sm">
              {duplicates.map(({ a, b }) => (
                <li
                  key={`${a.id}-${b.id}`}
                  className="rounded-lg border border-gray-200 p-2 dark:border-slate-700"
                >
                  <div className="text-gray-700 dark:text-slate-200">{personSummary(a)}</div>
                  <div className="text-gray-700 dark:text-slate-200">{personSummary(b)}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      onClick={() => handleMerge(a.id, b.id)}
                      disabled={busy}
                      className="flex-1 rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                    >
                      Keep #1, merge #2 in
                    </button>
                    <button
                      onClick={() => handleMerge(b.id, a.id)}
                      disabled={busy}
                      className="flex-1 rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                    >
                      Keep #2, merge #1 in
                    </button>
                    <button
                      onClick={() => handleDismissDuplicate(a.id, b.id)}
                      disabled={busy}
                      title="Confirm these are different people — stop flagging this pair"
                      className="rounded-lg px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-700"
                    >
                      Not a duplicate
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {dismissedDuplicates.length > 0 && (
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer text-xs font-medium text-gray-500 dark:text-slate-400">
                Dismissed ({dismissedDuplicates.length}) — confirmed not duplicates
              </summary>
              <ul className="mt-2 space-y-2">
                {dismissedDuplicates.map(({ a, b }) => (
                  <li key={`${a.id}-${b.id}`} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-gray-500 dark:text-slate-400">
                      {displayName(a)} &amp; {displayName(b)}
                    </span>
                    <button
                      onClick={() => handleRestoreDuplicate(a.id, b.id)}
                      className="shrink-0 text-xs text-brand hover:underline dark:text-brand-soft"
                    >
                      Re-flag
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Modal>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-gray-500 dark:text-slate-400">{children}</div>;
}

function PanelButton({
  children,
  onClick,
  disabled,
  className = "",
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-lg border border-gray-300 dark:border-slate-600 px-3 py-1.5 font-medium text-gray-700 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

const relateSelectClass =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100";

/** Pick a reference person and one or more others; shows how each relates. */
function RelationshipPanel({
  ids,
  setIds,
  people,
  byId,
  families,
  onShowPath,
}: {
  ids: string[];
  setIds: React.Dispatch<React.SetStateAction<string[]>>;
  people: Individual[];
  byId: Map<string, Individual>;
  families: Family[];
  onShowPath: (aId: string, bId: string) => void;
}) {
  const refId = ids[0] ?? "";
  const setAt = (i: number, val: string) => setIds(ids.map((x, j) => (j === i ? val : x)));

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-gray-500 dark:text-slate-400">
        Pick a reference person, then one or more others to see how each relates to them.
      </p>
      {ids.map((id, i) => {
        const rel = i > 0 && refId && id ? describeRelationship(refId, id, byId, families) : null;
        const path = rel ? relationshipPath(refId, id, families) : [];
        return (
          <div key={i}>
            <div className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-xs font-medium text-gray-500 dark:text-slate-400">
                {i === 0 ? "Reference" : `Person ${i + 1}`}
              </span>
              <select
                value={id}
                onChange={(e) => setAt(i, e.target.value)}
                className={relateSelectClass}
              >
                <option value="">— choose a person —</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {displayName(p)}
                  </option>
                ))}
              </select>
              {ids.length > 2 && i > 0 && (
                <button
                  onClick={() => setIds(ids.filter((_, j) => j !== i))}
                  className="px-1 text-gray-400 hover:text-red-600 dark:text-slate-500 dark:hover:text-red-400"
                  title="Remove"
                >
                  ✕
                </button>
              )}
            </div>
            {rel && (
              <div className="ml-20 mt-1 pl-2">
                <p
                  className={
                    rel.approximate
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-gray-700 dark:text-slate-200"
                  }
                >
                  {rel.sentence}
                </p>
                {path.length > 1 && (
                  <button
                    onClick={() => onShowPath(refId, id)}
                    className="text-xs text-brand hover:underline dark:text-brand-soft"
                  >
                    ↗ Show on tree
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      <button
        onClick={() => setIds([...ids, ""])}
        className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
      >
        + Add another person
      </button>
    </div>
  );
}

function Detail({ label, value, wrap }: { label: string; value: string | null; wrap?: boolean }) {
  if (!value) return null;
  return (
    <div className={wrap ? "" : "flex gap-2"}>
      <dt className="w-12 shrink-0 text-gray-400 dark:text-slate-500">{label}</dt>
      <dd className={wrap ? "whitespace-pre-wrap" : ""}>{value}</dd>
    </div>
  );
}

/** A clickable relative name that re-roots/selects on click. */
function RelativeLink({ person, onPick }: { person: Individual; onPick: (id: string) => void }) {
  return (
    <button
      onClick={() => onPick(person.id)}
      className="truncate text-left text-brand hover:underline dark:text-brand-soft"
      title={`Go to ${displayName(person)}`}
    >
      {displayName(person)}
    </button>
  );
}

/** A labelled list of clickable relatives (parents / children). */
function Relatives({
  label,
  people,
  onPick,
}: {
  label: string;
  people: Individual[];
  onPick: (id: string) => void;
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-gray-500 dark:text-slate-400">{label}</p>
      <ul className="space-y-0.5">
        {people.map((p) => (
          <li key={p.id} className="flex">
            <RelativeLink person={p} onPick={onPick} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Small status chip for a partnership: married / unmarried. */
function StatusBadge({ family }: { family: Family }) {
  const unmarried = family.unmarried;
  return (
    <span
      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
        unmarried
          ? "bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-slate-400"
          : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
      }`}
    >
      {unmarried ? "partner" : "⚭ married"}
    </span>
  );
}

/** Compact "m. <date·place> · div. <date>" string for a family, or null. */
function marriageDates(f: Family): string | null {
  const married = joinDatePlace(f.married_date, f.married_place);
  const parts: string[] = [];
  if (married) parts.push(`m. ${married}`);
  if (f.divorced_date) parts.push(`div. ${f.divorced_date}`);
  return parts.join(" · ") || null;
}

/** Assign husband/wife slots for a marriage, by sex, defaulting the anchor to husband. */
function assignSpouseSlots(
  anchor: Individual,
  other: Individual
): { husband_id: string; wife_id: string } {
  if (anchor.sex === "F") return { husband_id: other.id, wife_id: anchor.id };
  if (anchor.sex === "M") return { husband_id: anchor.id, wife_id: other.id };
  if (other.sex === "M") return { husband_id: other.id, wife_id: anchor.id };
  return { husband_id: anchor.id, wife_id: other.id };
}

/** Order-independent key for a pair of person ids. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** A child link payload, preserving birth order and relation type. */
function childRef(c: ChildRef): ChildRef {
  return { individual_id: c.individual_id, birth_order: c.birth_order, relation: c.relation };
}

/** The editable fields of an individual, for restoring/recreating on undo. */
function individualPayload(i: Individual): Partial<Individual> {
  return {
    given_name: i.given_name,
    middle_name: i.middle_name,
    surname: i.surname,
    sex: i.sex,
    birth_date: i.birth_date,
    birth_place: i.birth_place,
    death_date: i.death_date,
    death_place: i.death_place,
    age: i.age,
    notes: i.notes,
    photo_url: i.photo_url,
    is_unknown: i.is_unknown,
  };
}

function sexLabel(sex: string | null): string | null {
  if (sex === "M") return "Male";
  if (sex === "F") return "Female";
  return null;
}

function joinDatePlace(date: string | null, place: string | null): string | null {
  return [date, place].filter(Boolean).join(" · ") || null;
}

/** The parent to re-root on when going "up a level" (prefers the husband). */
function parentOf(personId: string, families: Family[]): string | null {
  for (const f of families) {
    if (f.children.some((c) => c.individual_id === personId)) {
      return f.husband_id ?? f.wife_id ?? null;
    }
  }
  return null;
}

/**
 * Best default root for the whole-tree view: the top-most ancestor (someone who
 * is not a child in any family) with the most descendants. Falls back to the
 * first individual if there are no clear ancestors (e.g. a cycle).
 */
function defaultRoot(individuals: Individual[], families: Family[]): string {
  const childIds = new Set<string>();
  for (const f of families) for (const c of f.children) childIds.add(c.individual_id);

  const childrenByParent = new Map<string, string[]>();
  for (const f of families) {
    for (const pid of [f.husband_id, f.wife_id]) {
      if (!pid) continue;
      const list = childrenByParent.get(pid) ?? [];
      for (const c of f.children) list.push(c.individual_id);
      childrenByParent.set(pid, list);
    }
  }
  const descendantCount = (id: string): number => {
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const c of childrenByParent.get(cur) ?? []) {
        if (!seen.has(c)) {
          seen.add(c);
          stack.push(c);
        }
      }
    }
    return seen.size;
  };

  const tops = individuals.filter((i) => !childIds.has(i.id));
  const candidates = tops.length > 0 ? tops : individuals;
  let best = candidates[0];
  let bestCount = -1;
  for (const c of candidates) {
    const n = descendantCount(c.id);
    if (n > bestCount) {
      bestCount = n;
      best = c;
    }
  }
  return best.id;
}
