import type { Family, Individual } from "../types";

/** Result of computing how person B relates to person A. */
export interface RelationshipResult {
  /** Short label, e.g. "first cousin once removed" or "grandfather". */
  label: string;
  /** Full sentence, e.g. "Isaac is Abraham's son." */
  sentence: string;
  /** True when the path crossed an unknown-depth ("gap") link, so the exact
   * relationship can't be determined. */
  approximate: boolean;
}

interface ParentEdge {
  parent: string;
  gap: boolean;
}

/** child id → parent edges, as built by {@link buildParentMap}. */
export type ParentMap = Map<string, ParentEdge[]>;

interface AncHit {
  dist: number;
  viaGap: boolean;
}

function fullName(p: Individual | undefined): string {
  if (!p) return "Unknown";
  const n = [p.given_name, p.surname].filter(Boolean).join(" ").trim();
  return n || "Unknown";
}

/** N "great-" prefixes (n may be 0). */
function greats(n: number): string {
  return n <= 0 ? "" : `${Array(n).fill("great").join("-")}-`;
}

function ordinal(n: number): string {
  const names = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh"];
  return names[n] ?? `${n}th`;
}

function removalText(n: number): string {
  if (n <= 0) return "";
  if (n === 1) return " once removed";
  if (n === 2) return " twice removed";
  if (n === 3) return " three times removed";
  return ` ${n} times removed`;
}

function ancestorTerm(gen: number, sex: string | null): string {
  const m = sex === "M";
  const f = sex === "F";
  if (gen === 1) return m ? "father" : f ? "mother" : "parent";
  const base = m ? "grandfather" : f ? "grandmother" : "grandparent";
  return greats(gen - 2) + base;
}

function descendantTerm(gen: number, sex: string | null): string {
  const m = sex === "M";
  const f = sex === "F";
  if (gen === 1) return m ? "son" : f ? "daughter" : "child";
  const base = m ? "grandson" : f ? "granddaughter" : "grandchild";
  return greats(gen - 2) + base;
}

/** B is the aunt/uncle (great- per `extra`) of A. Gendered by B's sex. */
function auntUncleTerm(extra: number, sex: string | null): string {
  const base = sex === "M" ? "uncle" : sex === "F" ? "aunt" : "aunt/uncle";
  return greats(extra) + base;
}

/** B is the niece/nephew of A; `gen` is B's distance below the shared ancestor. */
function nieceNephewTerm(gen: number, sex: string | null): string {
  const base = sex === "M" ? "nephew" : sex === "F" ? "niece" : "niece/nephew";
  if (gen === 2) return base;
  return `${greats(gen - 3)}grand-${base}`;
}

/** Build the child→parents map once and pass it to {@link describeRelationship}
 * / {@link relationshipPath} when calling them repeatedly (e.g. per row in the
 * relationship panel) — each call would otherwise rebuild it from scratch. */
export function buildParentMap(families: Family[]): ParentMap {
  const map: ParentMap = new Map();
  for (const fam of families) {
    const parents = [fam.husband_id, fam.wife_id].filter((p): p is string => !!p);
    for (const child of fam.children) {
      const edges = map.get(child.individual_id) ?? [];
      for (const parent of parents) edges.push({ parent, gap: fam.gap });
      map.set(child.individual_id, edges);
    }
  }
  return map;
}

/** Ancestors of `start` (including itself at distance 0) with the shortest
 * distance and whether any path to them crossed a gap link. */
function ancestors(start: string, parentMap: Map<string, ParentEdge[]>): Map<string, AncHit> {
  const result = new Map<string, AncHit>([[start, { dist: 0, viaGap: false }]]);
  const queue: string[] = [start];
  while (queue.length) {
    const id = queue.shift()!;
    const here = result.get(id)!;
    for (const { parent, gap } of parentMap.get(id) ?? []) {
      const cand: AncHit = { dist: here.dist + 1, viaGap: here.viaGap || gap };
      const existing = result.get(parent);
      if (!existing || cand.dist < existing.dist) {
        result.set(parent, cand);
        queue.push(parent);
      }
    }
  }
  return result;
}

function spouseSex(b: Individual | undefined): string {
  return b?.sex === "M" ? "husband" : b?.sex === "F" ? "wife" : "spouse";
}

/** Co-parent / spouse ids of a person (people they share a family with). */
function spouseIdsOf(id: string, families: Family[]): string[] {
  const out: string[] = [];
  for (const f of families) {
    if (f.husband_id === id && f.wife_id) out.push(f.wife_id);
    else if (f.wife_id === id && f.husband_id) out.push(f.husband_id);
  }
  return out;
}

function parentIdsOf(id: string, parentMap: Map<string, ParentEdge[]>): string[] {
  return (parentMap.get(id) ?? []).map((e) => e.parent);
}

function isParentOf(parent: string, child: string, parentMap: Map<string, ParentEdge[]>): boolean {
  return parentIdsOf(child, parentMap).includes(parent);
}

function isSibling(x: string, y: string, parentMap: Map<string, ParentEdge[]>): boolean {
  if (x === y) return false;
  const px = parentIdsOf(x, parentMap);
  return parentIdsOf(y, parentMap).some((p) => px.includes(p));
}

const bySex = (sex: string | null, m: string, f: string, n: string) =>
  sex === "M" ? m : sex === "F" ? f : n;

/** In-law / step relationship of B to A (when there's no blood tie). Covers the
 * common cases: sibling-, parent-, and child-in-law, and step-parent/child. */
function inLawLabel(
  aId: string,
  bId: string,
  B: Individual | undefined,
  families: Family[],
  parentMap: ParentMap
): string | null {
  const sex = B?.sex ?? null;
  const bSpouses = spouseIdsOf(bId, families);
  const aSpouses = spouseIdsOf(aId, families);

  // B is married to a sibling/child/parent of A.
  for (const s of bSpouses) {
    if (isSibling(s, aId, parentMap)) return bySex(sex, "brother-in-law", "sister-in-law", "sibling-in-law");
    if (isParentOf(aId, s, parentMap)) return bySex(sex, "son-in-law", "daughter-in-law", "child-in-law");
    if (isParentOf(s, aId, parentMap)) return bySex(sex, "stepfather", "stepmother", "step-parent");
  }
  // B is a sibling/parent/child of A's spouse.
  for (const as of aSpouses) {
    if (isSibling(as, bId, parentMap)) return bySex(sex, "brother-in-law", "sister-in-law", "sibling-in-law");
    if (isParentOf(bId, as, parentMap)) return bySex(sex, "father-in-law", "mother-in-law", "parent-in-law");
    if (isParentOf(as, bId, parentMap)) return bySex(sex, "stepson", "stepdaughter", "stepchild");
  }
  return null;
}

/** Ancestors of `start` (incl. itself) mapped to the path from `start` up to them. */
function ancestorPaths(start: string, parentMap: Map<string, ParentEdge[]>): Map<string, string[]> {
  const result = new Map<string, string[]>([[start, [start]]]);
  const queue: string[] = [start];
  while (queue.length) {
    const id = queue.shift()!;
    const path = result.get(id)!;
    for (const p of parentIdsOf(id, parentMap)) {
      if (!result.has(p)) {
        result.set(p, [...path, p]);
        queue.push(p);
      }
    }
  }
  return result;
}

/** The chain of person ids connecting A and B through their nearest common
 * ancestor (A … ancestor … B), for highlighting on the chart. Empty if none. */
export function relationshipPath(
  aId: string,
  bId: string,
  families: Family[],
  parentMap: ParentMap = buildParentMap(families)
): string[] {
  if (aId === bId) return [aId];
  const pa = ancestorPaths(aId, parentMap);
  const pb = ancestorPaths(bId, parentMap);
  let best: { c: string; total: number } | null = null;
  for (const [id, path] of pa) {
    const other = pb.get(id);
    if (!other) continue;
    const total = path.length + other.length;
    if (!best || total < best.total) best = { c: id, total };
  }
  if (!best) return [];
  const up = pa.get(best.c)!; // A → … → c
  const down = pb.get(best.c)!; // B → … → c
  return [...up, ...down.slice(0, -1).reverse()]; // A … c … B
}

/** The blood-relationship label of B to A (e.g. "half-sister", "grandson"),
 * ignoring any marriage between them. Returns null when there is no common
 * ancestor. `approximate` is set when an unknown-depth ("gap") link is on the
 * path. */
function bloodLabel(
  aId: string,
  bId: string,
  B: Individual | undefined,
  parentMap: ParentMap
): { label: string; approximate: boolean } | null {
  const ancA = ancestors(aId, parentMap);
  const ancB = ancestors(bId, parentMap);

  // Nearest common ancestor: minimise total distance.
  let best: { dA: number; dB: number; viaGap: boolean } | null = null;
  for (const [id, a] of ancA) {
    const b = ancB.get(id);
    if (!b) continue;
    const total = a.dist + b.dist;
    if (!best || total < best.dA + best.dB) {
      best = { dA: a.dist, dB: b.dist, viaGap: a.viaGap || b.viaGap };
    }
  }
  if (!best) return null;

  const { dA, dB, viaGap } = best;
  const sex = B?.sex ?? null;

  if (viaGap) {
    if (dA === 0) return { label: "descendant (generations unknown)", approximate: true };
    if (dB === 0) return { label: "ancestor (generations unknown)", approximate: true };
    return { label: "relative (exact relationship unknown)", approximate: true };
  }

  if (dA === 0) return { label: descendantTerm(dB, sex), approximate: false };
  if (dB === 0) return { label: ancestorTerm(dA, sex), approximate: false };

  if (dA === 1 && dB === 1) {
    const sharedParents = (parentMap.get(aId) ?? []).filter((e) =>
      (parentMap.get(bId) ?? []).some((x) => x.parent === e.parent)
    ).length;
    const half = sharedParents < 2 ? "half-" : "";
    const label = sex === "M" ? `${half}brother` : sex === "F" ? `${half}sister` : `${half}sibling`;
    return { label, approximate: false };
  }
  if (dB === 1) return { label: auntUncleTerm(dA - 2, sex), approximate: false };
  if (dA === 1) return { label: nieceNephewTerm(dB, sex), approximate: false };

  const degree = Math.min(dA, dB) - 1;
  const removal = Math.abs(dA - dB);
  return { label: `${ordinal(degree)} cousin${removalText(removal)}`, approximate: false };
}

/**
 * Describe how person B relates to person A (e.g. "B is A's grandfather").
 * Reports a marriage AND any blood tie (e.g. "wife — also his half-sister"),
 * since a couple can be related in more than one way. Unknown-depth ("gap")
 * links make the result approximate.
 */
export function describeRelationship(
  aId: string,
  bId: string,
  byId: Map<string, Individual>,
  families: Family[],
  parentMap: ParentMap = buildParentMap(families)
): RelationshipResult {
  const A = byId.get(aId);
  const B = byId.get(bId);
  const nameA = fullName(A);
  const nameB = fullName(B);

  if (aId === bId) {
    return { label: "same person", sentence: `${nameA} is the same person.`, approximate: false };
  }

  const blood = bloodLabel(aId, bId, B, parentMap);
  const married = families.some(
    (f) =>
      (f.husband_id === aId && f.wife_id === bId) || (f.husband_id === bId && f.wife_id === aId)
  );

  if (married) {
    const term = spouseSex(B);
    const poss = A?.sex === "M" ? "his" : A?.sex === "F" ? "her" : "their";
    const extra = blood ? ` (also ${poss} ${blood.label})` : "";
    return {
      label: blood ? `${term} & ${blood.label}` : term,
      sentence: `${nameB} is ${nameA}'s ${term}${extra}.`,
      approximate: blood?.approximate ?? false,
    };
  }

  if (!blood) {
    const inLaw = inLawLabel(aId, bId, B, families, parentMap);
    if (inLaw) {
      return { label: inLaw, sentence: `${nameB} is ${nameA}'s ${inLaw}.`, approximate: false };
    }
    return {
      label: "no relationship",
      sentence: `No relationship found between ${nameA} and ${nameB} in this tree.`,
      approximate: false,
    };
  }

  if (blood.approximate) {
    const detail =
      blood.label.startsWith("descendant")
        ? `${nameB} is a descendant of ${nameA}, but the number of generations is unknown.`
        : blood.label.startsWith("ancestor")
          ? `${nameB} is an ancestor of ${nameA}, but the number of generations is unknown.`
          : `${nameA} and ${nameB} are related, but an incomplete lineage means the exact relationship is unknown.`;
    return { label: blood.label, sentence: detail, approximate: true };
  }

  return { label: blood.label, sentence: `${nameB} is ${nameA}'s ${blood.label}.`, approximate: false };
}
