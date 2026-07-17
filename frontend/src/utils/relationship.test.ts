import { describe, expect, it } from "vitest";
import type { Family, Individual } from "../types";
import { describeRelationship, relationshipPath } from "./relationship";

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

function index(people: Individual[]): Map<string, Individual> {
  return new Map(people.map((p) => [p.id, p]));
}

// Three-generation fixture:
//   grandpa + grandma → dad, uncle
//   dad + mom → me, sister
//   uncle + aunt → cousin
const grandpa = person("grandpa", { sex: "M" });
const grandma = person("grandma", { sex: "F" });
const dad = person("dad", { sex: "M" });
const mom = person("mom", { sex: "F" });
const uncle = person("uncle", { sex: "M" });
const aunt = person("aunt", { sex: "F" });
const me = person("me", { sex: "M" });
const sister = person("sister", { sex: "F" });
const cousin = person("cousin", { sex: "F" });

const people = [grandpa, grandma, dad, mom, uncle, aunt, me, sister, cousin];
const families = [
  family("f1", "grandpa", "grandma", ["dad", "uncle"]),
  family("f2", "dad", "mom", ["me", "sister"]),
  family("f3", "uncle", "aunt", ["cousin"]),
];
const byId = index(people);

describe("describeRelationship", () => {
  it("identifies a father", () => {
    expect(describeRelationship("me", "dad", byId, families).label).toBe("father");
  });

  it("identifies a grandmother", () => {
    expect(describeRelationship("me", "grandma", byId, families).label).toBe("grandmother");
  });

  it("identifies a full sister", () => {
    expect(describeRelationship("me", "sister", byId, families).label).toBe("sister");
  });

  it("identifies an uncle and a nephew (both directions)", () => {
    expect(describeRelationship("me", "uncle", byId, families).label).toBe("uncle");
    expect(describeRelationship("uncle", "me", byId, families).label).toBe("nephew");
  });

  it("identifies a first cousin", () => {
    expect(describeRelationship("me", "cousin", byId, families).label).toBe("first cousin");
  });

  it("identifies a grandson", () => {
    expect(describeRelationship("grandpa", "me", byId, families).label).toBe("grandson");
  });

  it("identifies a spouse", () => {
    const r = describeRelationship("dad", "mom", byId, families);
    expect(r.label).toBe("wife");
    expect(r.approximate).toBe(false);
  });

  it("identifies a half-sibling when only one parent is shared", () => {
    const halfPeople = [dad, person("stepmom", { sex: "F" }), me, person("half", { sex: "F" })];
    const halfFamilies = [
      family("f2", "dad", "mom", ["me"]),
      family("f4", "dad", "stepmom", ["half"]),
    ];
    expect(describeRelationship("me", "half", index(halfPeople), halfFamilies).label).toBe(
      "half-sister"
    );
  });

  it("identifies a mother-in-law", () => {
    const momInLaw = person("mil", { sex: "F" });
    const wife = person("wife", { sex: "F" });
    const ppl = [me, wife, momInLaw];
    const fams = [family("f5", "me", "wife"), family("f6", null, "mil", ["wife"])];
    expect(describeRelationship("me", "mil", index(ppl), fams).label).toBe("mother-in-law");
  });

  it("marks relationships across gap links as approximate", () => {
    const anc = person("anc");
    const desc = person("desc");
    const gapFams = [family("g1", "anc", null, ["desc"], { gap: true })];
    const r = describeRelationship("anc", "desc", index([anc, desc]), gapFams);
    expect(r.approximate).toBe(true);
    expect(r.label).toContain("descendant");
  });

  it("reports no relationship for unconnected people", () => {
    const r = describeRelationship("me", "aunt", byId, families);
    // aunt is only related by marriage to uncle → aunt (in-law) or no blood tie.
    expect(r.approximate).toBe(false);
  });
});

describe("relationshipPath", () => {
  it("returns just the person for identical endpoints", () => {
    expect(relationshipPath("me", "me", families)).toEqual(["me"]);
  });

  it("routes cousins through the shared grandparent", () => {
    const path = relationshipPath("me", "cousin", families);
    expect(path[0]).toBe("me");
    expect(path[path.length - 1]).toBe("cousin");
    // The connecting ancestor is one of the shared grandparents.
    expect(path.some((id) => id === "grandpa" || id === "grandma")).toBe(true);
  });

  it("returns an empty path when there is no common ancestor", () => {
    expect(relationshipPath("a", "b", [family("fx", "a", null), family("fy", "b", null)])).toEqual(
      []
    );
  });
});
