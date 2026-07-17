import { describe, expect, it } from "vitest";
import { gedcomToIso, isoToGedcom, yearOf } from "./gedcomDate";

describe("isoToGedcom", () => {
  it("converts a full ISO date to GEDCOM day-month-year", () => {
    expect(isoToGedcom("1880-03-12")).toBe("12 MAR 1880");
  });

  it("drops leading zeros on the day", () => {
    expect(isoToGedcom("1900-01-05")).toBe("5 JAN 1900");
  });

  it("rejects anything that is not a full ISO date", () => {
    expect(isoToGedcom("1880-03")).toBe("");
    expect(isoToGedcom("ABT 1850")).toBe("");
    expect(isoToGedcom("")).toBe("");
  });

  it("rejects an out-of-range month", () => {
    expect(isoToGedcom("1880-13-12")).toBe("");
  });
});

describe("gedcomToIso", () => {
  it("converts an exact GEDCOM date to ISO", () => {
    expect(gedcomToIso("12 MAR 1880")).toBe("1880-03-12");
  });

  it("accepts full month names and mixed case", () => {
    expect(gedcomToIso("3 march 1880")).toBe("1880-03-03");
  });

  it("pads short years to four digits", () => {
    expect(gedcomToIso("1 JAN 70")).toBe("0070-01-01");
  });

  it("rejects impossible calendar days", () => {
    expect(gedcomToIso("31 FEB 1900")).toBe("");
    expect(gedcomToIso("29 FEB 1900")).toBe(""); // 1900 is not a leap year
    expect(gedcomToIso("29 FEB 2000")).toBe("2000-02-29"); // 2000 is
  });

  it("rejects approximate/partial dates and bad month words", () => {
    expect(gedcomToIso("ABT 1850")).toBe("");
    expect(gedcomToIso("MAR 1880")).toBe("");
    expect(gedcomToIso("12 JUNETEENTH 1880")).toBe("");
  });

  it("round-trips with isoToGedcom", () => {
    expect(gedcomToIso(isoToGedcom("1880-03-12"))).toBe("1880-03-12");
  });
});

describe("yearOf", () => {
  it("takes the year, not the day, from a day-month-year date", () => {
    expect(yearOf("12 MAR 1880")).toBe(1880);
  });

  it("handles qualified and approximate dates", () => {
    expect(yearOf("ABT 1850")).toBe(1850);
    expect(yearOf("BEF 1900")).toBe(1900);
  });

  it("falls back to a short run for biblical years", () => {
    expect(yearOf("ABT 70")).toBe(70);
  });

  it("negates BC/BCE years so they compare correctly", () => {
    expect(yearOf("2000 BC")).toBe(-2000);
    expect(yearOf("ABT 1500 B.C.E.")).toBe(-1500);
    const early = yearOf("2000 BC")!;
    const late = yearOf("1500 BC")!;
    expect(early).toBeLessThan(late);
  });

  it("returns null when there is no year", () => {
    expect(yearOf(null)).toBeNull();
    expect(yearOf(undefined)).toBeNull();
    expect(yearOf("unknown")).toBeNull();
  });
});
