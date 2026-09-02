import { useCallback, useRef } from "react";

/**
 * Photos for chart nodes.
 *
 * The chart endpoints deliberately carry NO photos: a 3,000-node chart with a
 * 6 KB thumbnail on every card was 18.5 MB on the wire versus under 1 MB
 * without. Instead, once a chart arrives, the ids on it are sent in one
 * batched request to the photos endpoint and the thumbnails are attached to
 * the node objects client-side — the chart components keep reading
 * `person.photo_url` off the node exactly as before.
 */

/** The shape both chart node types share; `unions` on descendant nodes,
 * `children` on ancestor nodes. */
type ChartNode = {
  id: string;
  photo_url?: string | null;
  unions?: { spouse: ChartNode | null; children: ChartNode[] }[];
  children?: ChartNode[];
};

/** Photos endpoint batch limit (mirrors PHOTO_BATCH_MAX on the backend). */
const BATCH_MAX = 2000;

/** Every node of a chart, depth-first. */
function* walk(root: ChartNode): Generator<ChartNode> {
  const stack: ChartNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    yield node;
    if (node.unions) {
      for (const u of node.unions) {
        if (u.spouse) stack.push(u.spouse);
        for (const c of u.children) stack.push(c);
      }
    } else if (node.children) {
      for (const c of node.children) stack.push(c);
    }
  }
}

/** Unique person ids on a chart. */
export function collectNodeIds(root: ChartNode): Set<string> {
  const ids = new Set<string>();
  for (const node of walk(root)) ids.add(node.id);
  return ids;
}

/** Set `photo_url` on every node whose id has a known photo. Mutates the nodes
 * in place (the same person can appear on several nodes). Returns whether any
 * node gained a photo it didn't already have. */
export function attachPhotos(root: ChartNode, photos: Map<string, string | null>): boolean {
  let changed = false;
  for (const node of walk(root)) {
    const photo = photos.get(node.id);
    if (photo && node.photo_url !== photo) {
      node.photo_url = photo;
      changed = true;
    }
  }
  return changed;
}

/**
 * A per-tree photo cache plus a loader for chart roots.
 *
 * `cacheKey` identifies the tree (its id, or the share token); the cache is
 * dropped when it changes. Re-rooting the chart only fetches ids the cache has
 * not seen yet — every id fetched is remembered, with or without a photo, so
 * a person without one is never asked for twice.
 *
 * `load(root)` attaches already-cached photos synchronously (before the first
 * await, so a `setState(root)` right after the call renders them) and then
 * resolves TRUE if a fetch added more — the caller re-renders by putting a
 * shallow clone of the (now mutated) root into state.
 */
export function usePhotoCache(
  cacheKey: string | null | undefined,
  fetchPhotos: (ids: string[]) => Promise<Record<string, string>>
): (root: ChartNode) => Promise<boolean> {
  const cache = useRef(new Map<string, string | null>());
  const cacheFor = useRef(cacheKey);
  if (cacheFor.current !== cacheKey) {
    cache.current = new Map();
    cacheFor.current = cacheKey;
  }
  const fetchRef = useRef(fetchPhotos);
  fetchRef.current = fetchPhotos;

  return useCallback(async (root: ChartNode): Promise<boolean> => {
    const key = cacheFor.current;
    const known = cache.current;
    attachPhotos(root, known);
    const missing = [...collectNodeIds(root)].filter((id) => !known.has(id));
    if (missing.length === 0) return false;
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += BATCH_MAX) batches.push(missing.slice(i, i + BATCH_MAX));
    const results = await Promise.all(batches.map((ids) => fetchRef.current(ids)));
    // The tree changed underneath this fetch — its cache is gone; don't seed
    // the new tree's cache with another tree's answers.
    if (cacheFor.current !== key) return false;
    const fetched = Object.assign({}, ...results) as Record<string, string>;
    for (const id of missing) known.set(id, fetched[id] ?? null);
    return attachPhotos(root, known);
  }, []);
}
