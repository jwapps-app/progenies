import type { Family, Individual } from "../types";
import { displayName } from "../types";

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

/** Best-effort year extraction from a free-text GEDCOM date (first 3–4 digit run). */
function year(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/\d{3,4}/);
  return m ? parseInt(m[0], 10) : null;
}

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

  // 4. Ancestry loops: a person who is their own ancestor.
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
  for (const start of individuals) {
    if (looped.has(start.id)) continue;
    const stack = [start.id];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      for (const p of parents.get(cur) ?? []) {
        if (p === start.id) {
          looped.add(start.id);
          break;
        }
        if (!seen.has(p)) {
          seen.add(p);
          stack.push(p);
        }
      }
      if (looped.has(start.id)) break;
    }
  }
  for (const id of looped) {
    warnings.push({
      key: `ancestry-loop:${id}`,
      personId: id,
      message: `${name(id)} is listed as their own ancestor (a loop in the tree).`,
    });
  }

  return warnings;
}
