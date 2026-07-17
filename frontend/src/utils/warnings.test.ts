import { describe, expect, it } from "vitest";
import type { Family, Individual } from "../types";
import { findWarnings } from "./warnings";

function person(id: string, over: Partial<Individual> = {}): Individual {
  return {
    id,
    tree_id: "t1",
    given_name: id,
    middle_name: null,
    surname: null,
    married_name: null,
    nickname: null,
    sex: null,
    birth_date: null,
    birth_place: null,
    death_date: null,
    death_place: null,
    age: null,
    notes: null,
    photo_url: null,
    gedcom_xref: null,
    is_unknown: false,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

function family(
  id: string,
  husband: string | null,
  wife: string | null,
  childIds: string[] = [],
  over: Partial<Family> = {}
): Family {
  return {
    id,
    tree_id: "t1",
    husband_id: husband,
    wife_id: wife,
    married_date: null,
    married_place: null,
    divorced_date: null,
    notes: null,
    marriage_order: null,
    gap: false,
    unmarried: false,
    gedcom_xref: null,
    children: childIds.map((c, i) => ({
      individual_id: c,
      birth_order: i + 1,
      relation: "biological",
    })),
    ...over,
  };
}

describe("findWarnings", () => {
  it("returns no warnings for a clean tree", () => {
    const dad = person("dad", { birth_date: "1850", death_date: "1920" });
    const mom = person("mom", { birth_date: "1855" });
    const kid = person("kid", { birth_date: "1880" });
    const warnings = findWarnings([dad, mom, kid], [family("f1", "dad", "mom", ["kid"])]);
    expect(warnings).toEqual([]);
  });

  it("flags death before birth", () => {
    const p = person("p", { birth_date: "1900", death_date: "1850" });
    const warnings = findWarnings([p], []);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].key).toBe("death-before-birth:p:1900:1850");
    expect(warnings[0].personId).toBe("p");
  });

  it("does NOT flag BC lifespans where the death year is numerically smaller", () => {
    // 2000 BC → 1900 BC is a normal forward lifespan.
    const p = person("p", { birth_date: "2000 BC", death_date: "1900 BC" });
    expect(findWarnings([p], [])).toEqual([]);
  });

  it("flags self-marriage", () => {
    const p = person("p");
    const warnings = findWarnings([p], [family("f1", "p", "p")]);
    expect(warnings.some((w) => w.key === "self-marriage:f1")).toBe(true);
  });

  it("flags a parent who is not older than their biological child", () => {
    const dad = person("dad", { birth_date: "1900" });
    const kid = person("kid", { birth_date: "1900" });
    const warnings = findWarnings([dad, kid], [family("f1", "dad", null, ["kid"])]);
    expect(warnings.some((w) => w.key.startsWith("parent-not-older:dad:kid"))).toBe(true);
  });

  it("flags an implausibly young parent", () => {
    const mom = person("mom", { birth_date: "1890" });
    const kid = person("kid", { birth_date: "1900" });
    const warnings = findWarnings([mom, kid], [family("f1", null, "mom", ["kid"])]);
    expect(warnings.some((w) => w.key.startsWith("parent-young:mom:kid"))).toBe(true);
  });

  it("skips parent-age checks for non-biological children", () => {
    const dad = person("dad", { birth_date: "1900" });
    const kid = person("kid", { birth_date: "1900" });
    const fam = family("f1", "dad", null, []);
    fam.children = [{ individual_id: "kid", birth_order: 1, relation: "adopted" }];
    expect(findWarnings([dad, kid], [fam])).toEqual([]);
  });

  it("flags ancestry loops", () => {
    // a is a parent of b, and b is a parent of a.
    const a = person("a");
    const b = person("b");
    const warnings = findWarnings(
      [a, b],
      [family("f1", "a", null, ["b"]), family("f2", "b", null, ["a"])]
    );
    expect(warnings.some((w) => w.key === "ancestry-loop:a")).toBe(true);
  });
});
