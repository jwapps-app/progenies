import type { Family, Individual } from "../types";
import { displayName } from "../types";
import { yearOf } from "./gedcomDate";

export interface TreeWarning {
  /**
   * Stable, content-derived id for this issue. Encodes the warning type, the
   * people involved, and the salient values — so dismissing it persists, yet a
   * later data change (different dates) produces a new key and re-surfaces it.
   */
  key: string;
  /** The person the warning is about (for jump-to navigation), if any. */
  personId?: string;
  message: string;
}

/** BC-aware year extraction. The previous local version ignored era, so every
 * biblical (BC) lineage fired false "died before born" / "parent not older"
 * warnings — BC years run BACKWARD (2000 BC precedes 1500 BC). */
const year = yearOf;

/**
 * Scan the tree for likely data errors: impossible dates, implausible parent
 * ages, self-marriages, and ancestry loops (a person who is their own ancestor).
 * Heuristic and advisory — never blocks the user.
 */
export function findWarnings(individuals: Individual[], families: Family[]): TreeWarning[] {
  const warnings: TreeWarning[] = [];
  const byId = new Map(individuals.map((i) => [i.id, i]));
  const name = (id: string) => displayName(byId.get(id));

  // 1. Death before birth, and age sanity.
  for (const p of individuals) {
    const b = year(p.birth_date);
    const d = year(p.death_date);
    if (b !== null && d !== null && d < b) {
      warnings.push({
        key: `death-before-birth:${p.id}:${b}:${d}`,
        personId: p.id,
        message: `${displayName(p)} died (${p.death_date}) before being born (${p.birth_date}).`,
      });
    }
  }

  // 2. Self-marriage.
  for (const f of families) {
    if (f.husband_id && f.husband_id === f.wife_id) {
      warnings.push({
        key: `self-marriage:${f.id}`,
        personId: f.husband_id,
        message: `${name(f.husband_id)} is married to themselves.`,
      });
    }
  }

  // 3. Implausible parent age (biological children only).
  for (const f of families) {
    for (const c of f.children) {
      if (c.relation !== "biological") continue;
      const cy = year(byId.get(c.individual_id)?.birth_date ?? null);
      if (cy === null) continue;
      for (const pid of [f.husband_id, f.wife_id]) {
        if (!pid) continue;
        const py = year(byId.get(pid)?.birth_date ?? null);
        if (py === null) continue;
        if (py >= cy) {
          warnings.push({
            key: `parent-not-older:${pid}:${c.individual_id}:${py}:${cy}`,
            personId: pid,
            message: `${name(pid)} (b. ${byId.get(pid)?.birth_date}) is a parent of ${name(c.individual_id)} (b. ${byId.get(c.individual_id)?.birth_date}) but is not older.`,
          });
        } else if (cy - py < 13) {
          warnings.push({
            key: `parent-young:${pid}:${c.individual_id}:${py}:${cy}`,
            personId: pid,
            message: `${name(pid)} was only ${cy - py} when ${name(c.individual_id)} was born — check the dates.`,
          });
        }
      }
    }
  }

  // 4. Ancestry loops: a person who is their own ancestor — i.e. anyone on a
  //    cycle in the child→parent graph. One DFS pass (iterative Tarjan SCC, so
  //    deep lineages can't overflow the call stack) finds every such person in
  //    O(n+E); the previous version ran a BFS per individual, O(n×E).
  const parents = new Map<string, string[]>();
  for (const f of families) {
    const ps = [f.husband_id, f.wife_id].filter((p): p is string => !!p);
    for (const c of f.children) {
      const arr = parents.get(c.individual_id) ?? [];
      arr.push(...ps);
      parents.set(c.individual_id, arr);
    }
  }
  const looped = new Set<string>();
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const sccStack: string[] = [];
  let counter = 0;
  for (const start of individuals) {
    if (index.has(start.id)) continue;
    const work: { id: string; edge: number }[] = [{ id: start.id, edge: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const { id } = frame;
      if (frame.edge === 0) {
        index.set(id, counter);
        low.set(id, counter);
        counter += 1;
        sccStack.push(id);
        onStack.add(id);
      }
      const edges = parents.get(id) ?? [];
      let descended = false;
      while (frame.edge < edges.length) {
        const p = edges[frame.edge++];
        if (!index.has(p)) {
          work.push({ id: p, edge: 0 });
          descended = true;
          break;
        }
        if (onStack.has(p)) low.set(id, Math.min(low.get(id)!, index.get(p)!));
      }
      if (descended) continue;
      work.pop();
      const caller = work[work.length - 1];
      if (caller) low.set(caller.id, Math.min(low.get(caller.id)!, low.get(id)!));
      if (low.get(id) === index.get(id)) {
        // Root of a strongly connected component — pop it. Members of a
        // multi-person component (or a self-loop) are their own ancestors.
        const scc: string[] = [];
        for (;;) {
          const v = sccStack.pop()!;
          onStack.delete(v);
          scc.push(v);
          if (v === id) break;
        }
        if (scc.length > 1 || (parents.get(id) ?? []).includes(id)) {
          for (const v of scc) looped.add(v);
        }
      }
    }
  }
  for (const p of individuals) {
    if (!looped.has(p.id)) continue;
    warnings.push({
      key: `ancestry-loop:${p.id}`,
      personId: p.id,
      message: `${name(p.id)} is listed as their own ancestor (a loop in the tree).`,
    });
  }

  return warnings;
}
