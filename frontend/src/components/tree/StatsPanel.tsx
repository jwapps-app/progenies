import { useMemo } from "react";
import type { Family, Individual } from "../../types";
import { displayName } from "../../types";
import { yearOf } from "../../utils/gedcomDate";

/** Computed-on-demand statistics for the current tree. Pure function of the
 * already-loaded people + families — no extra fetches. */
export default function StatsPanel({
  individuals,
  families,
}: {
  individuals: Individual[];
  families: Family[];
}) {
  const stats = useMemo(() => {
    const real = individuals.filter((i) => !i.is_unknown);
    const males = real.filter((i) => i.sex === "M").length;
    const females = real.filter((i) => i.sex === "F").length;

    // Lifespans: explicit age field, or death year − birth year (BC-aware).
    let lifespanSum = 0;
    let lifespanCount = 0;
    let longest: { person: Individual; years: number } | null = null;
    for (const p of real) {
      let years: number | null = null;
      const b = yearOf(p.birth_date);
      const d = yearOf(p.death_date);
      if (b !== null && d !== null && d >= b) years = d - b;
      else if (p.age) {
        const parsed = parseInt(p.age.replace(/[^\d]/g, ""), 10);
        if (!Number.isNaN(parsed) && parsed > 0) years = parsed;
      }
      if (years !== null && years <= 1100) {
        lifespanSum += years;
        lifespanCount += 1;
        if (!longest || years > longest.years) longest = { person: p, years };
      }
    }

    // Generations: longest parent→child chain (DFS with cycle guard).
    const childrenOf = new Map<string, string[]>();
    for (const f of families) {
      for (const pid of [f.husband_id, f.wife_id]) {
        if (!pid) continue;
        const arr = childrenOf.get(pid) ?? [];
        arr.push(...f.children.map((c) => c.individual_id));
        childrenOf.set(pid, arr);
      }
    }
    const depthMemo = new Map<string, number>();
    const depth = (id: string, seen: Set<string>): number => {
      if (seen.has(id)) return 0; // cycle guard
      const memo = depthMemo.get(id);
      if (memo !== undefined) return memo;
      seen.add(id);
      const kids = childrenOf.get(id) ?? [];
      const d = kids.length === 0 ? 1 : 1 + Math.max(...kids.map((k) => depth(k, seen)));
      seen.delete(id);
      depthMemo.set(id, d);
      return d;
    };
    const isChild = new Set(families.flatMap((f) => f.children.map((c) => c.individual_id)));
    const tops = real.filter((p) => childrenOf.has(p.id) && !isChild.has(p.id));
    const generations = tops.length
      ? Math.max(...tops.map((t) => depth(t.id, new Set())))
      : real.length > 0
        ? 1
        : 0;

    // Most children (across all of a person's families).
    let mostChildren: { person: Individual; count: number } | null = null;
    for (const p of real) {
      const count = new Set(childrenOf.get(p.id) ?? []).size;
      if (count > 0 && (!mostChildren || count > mostChildren.count)) {
        mostChildren = { person: p, count };
      }
    }

    // Birth-year range.
    const birthYears = real
      .map((p) => ({ p, y: yearOf(p.birth_date) }))
      .filter((x): x is { p: Individual; y: number } => x.y !== null);
    birthYears.sort((a, b) => a.y - b.y);

    const fmtYear = (y: number) => (y < 0 ? `${-y} BC` : `${y}`);

    return {
      people: real.length,
      placeholders: individuals.length - real.length,
      families: families.length,
      marriages: families.filter((f) => !f.unmarried).length,
      males,
      females,
      unknownSex: real.length - males - females,
      avgLifespan: lifespanCount ? Math.round(lifespanSum / lifespanCount) : null,
      lifespanCount,
      longest,
      generations,
      mostChildren,
      earliest: birthYears[0] ?? null,
      latest: birthYears[birthYears.length - 1] ?? null,
      fmtYear,
    };
  }, [individuals, families]);

  const Row = ({ label, value }: { label: string; value: string | number }) => (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-sm text-gray-500 dark:text-slate-400">{label}</span>
      <span className="text-right text-sm font-semibold text-gray-800 dark:text-slate-100">
        {value}
      </span>
    </div>
  );

  return (
    <div className="divide-y divide-gray-100 dark:divide-slate-700">
      <Row label="People" value={stats.people} />
      {stats.placeholders > 0 && <Row label="Unknown placeholders" value={stats.placeholders} />}
      <Row label="Families" value={stats.families} />
      <Row
        label="Sex"
        value={`${stats.males} ♂ · ${stats.females} ♀${
          stats.unknownSex ? ` · ${stats.unknownSex} ?` : ""
        }`}
      />
      <Row label="Generations (deepest line)" value={stats.generations} />
      {stats.avgLifespan !== null && (
        <Row
          label={`Average lifespan (${stats.lifespanCount} known)`}
          value={`${stats.avgLifespan} years`}
        />
      )}
      {stats.longest && (
        <Row
          label="Longest-lived"
          value={`${displayName(stats.longest.person)} (${stats.longest.years})`}
        />
      )}
      {stats.mostChildren && (
        <Row
          label="Most children"
          value={`${displayName(stats.mostChildren.person)} (${stats.mostChildren.count})`}
        />
      )}
      {stats.earliest && (
        <Row
          label="Earliest birth"
          value={`${displayName(stats.earliest.p)} (${stats.fmtYear(stats.earliest.y)})`}
        />
      )}
      {stats.latest && stats.latest.p.id !== stats.earliest?.p.id && (
        <Row
          label="Latest birth"
          value={`${displayName(stats.latest.p)} (${stats.fmtYear(stats.latest.y)})`}
        />
      )}
    </div>
  );
}
