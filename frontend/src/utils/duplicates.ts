import type { Individual } from "../types";
import { displayName } from "../types";
import { yearOf } from "./gedcomDate";

export interface DuplicatePair {
  a: Individual;
  b: Individual;
}

function normName(p: Individual): string {
  return [p.given_name, p.surname].filter(Boolean).join(" ").toLowerCase().trim();
}

// BC-aware, shared with the warnings engine and birth-order sorting.
const year = yearOf;

/**
 * Find likely duplicate individuals: same name (given + surname) with compatible
 * birth years (equal, or at least one unknown). Conservative — placeholder
 * "unknown" people are skipped.
 */
export function findDuplicates(individuals: Individual[]): DuplicatePair[] {
  const byName = new Map<string, Individual[]>();
  for (const p of individuals) {
    if (p.is_unknown) continue;
    const n = normName(p);
    if (!n || n === "unknown") continue;
    (byName.get(n) ?? byName.set(n, []).get(n)!).push(p);
  }
  const pairs: DuplicatePair[] = [];
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const ya = year(group[i].birth_date);
        const yb = year(group[j].birth_date);
        if (ya === null || yb === null || ya === yb) pairs.push({ a: group[i], b: group[j] });
      }
    }
  }
  return pairs;
}

/** A compact "born … · died …" summary for distinguishing two candidates. */
export function personSummary(p: Individual): string {
  const parts = [displayName(p)];
  const dates = [p.birth_date, p.death_date].filter(Boolean).join("–");
  if (dates) parts.push(dates);
  else if (p.age) parts.push(`age ${p.age}`);
  if (p.birth_place) parts.push(p.birth_place);
  return parts.join(" · ");
}
