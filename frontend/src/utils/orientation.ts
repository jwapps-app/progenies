/**
 * Chart orientation preference, persisted in localStorage.
 *
 * There is a GLOBAL default (applies to every tree) plus an optional PER-TREE
 * override. The effective orientation for a tree is its override if set, else the
 * global default. Flipping the toolbar toggle on a tree sets that tree's override,
 * so it never disturbs the global default or other trees.
 */
export type Orientation = "vertical" | "horizontal";

const GLOBAL_KEY = "progenies.orientation.global";
const treeKey = (treeId: string) => `progenies.orientation.tree.${treeId}`;

function read(key: string): Orientation | null {
  try {
    let v = localStorage.getItem(key);
    if (v === null) {
      // One-time migration from the pre-rename ("Kindred") key namespace, so
      // saved orientation preferences survive the rebrand.
      const legacy = localStorage.getItem(key.replace(/^progenies\./, "kindred."));
      if (legacy !== null) {
        localStorage.setItem(key, legacy);
        v = legacy;
      }
    }
    return v === "vertical" || v === "horizontal" ? v : null;
  } catch {
    return null;
  }
}

export function getGlobalOrientation(): Orientation {
  return read(GLOBAL_KEY) ?? "vertical";
}

export function setGlobalOrientation(o: Orientation): void {
  try {
    localStorage.setItem(GLOBAL_KEY, o);
  } catch {
    /* ignore storage failures (private mode, etc.) */
  }
}

export function getTreeOverride(treeId: string): Orientation | null {
  return read(treeKey(treeId));
}

/** Set (or clear, with null) a tree's override of the global default. */
export function setTreeOverride(treeId: string, o: Orientation | null): void {
  try {
    if (o === null) localStorage.removeItem(treeKey(treeId));
    else localStorage.setItem(treeKey(treeId), o);
  } catch {
    /* ignore */
  }
}

export function effectiveOrientation(treeId: string): Orientation {
  return getTreeOverride(treeId) ?? getGlobalOrientation();
}
