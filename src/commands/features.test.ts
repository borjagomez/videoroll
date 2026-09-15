import { describe, it, expect } from "vitest";
import { searchFeatures } from "./features.js";
import { slugify } from "../io.js";
import type { Feature } from "../types.js";

function feature(name: string, extra: Partial<Feature> = {}): Feature {
  return {
    id: slugify(name),
    name,
    aliases: [],
    summary: "",
    category: "Time off",
    sourceUrls: [],
    docSteps: [],
    prerequisites: [],
    entities: [],
    ...extra,
  };
}

/** A slice of the shape the real Factorial catalog has. */
const CATALOG: Feature[] = [
  feature("Approve or reject a time off request"),
  feature("Request time off"),
  feature("Assign a time off approver to an employee"),
  feature("Clock in/out with Face Recognition", { category: "Time tracking" }),
  feature("Clock in/out on the desktop", { category: "Time tracking" }),
  feature("Include excluded employees back in time tracking", {
    category: "Time tracking",
  }),
  feature("Export the time off report", { category: "Reporting" }),
  feature("Create a new absence type", {
    category: "Time off settings",
    aliases: ["Add absence type"],
  }),
];

describe("searchFeatures", () => {
  it("returns only features matching every term, best first", () => {
    const { results } = searchFeatures(CATALOG, "approve time off");
    expect(results[0]!.name).toBe("Approve or reject a time off request");
    // The bug this guards: term-by-term scoring matched 120 of 125 features.
    expect(results.length).toBeLessThan(CATALOG.length);
    for (const r of results) expect(r.name.toLowerCase()).toContain("time off");
  });

  it("matches whole words, not substrings", () => {
    const { results } = searchFeatures(CATALOG, "clock in");
    // "in" must not match the "In" inside "Include".
    expect(results.some((r) => r.name.startsWith("Include"))).toBe(false);
    expect(results[0]!.name).toContain("Clock in");
  });

  it("ranks an exact phrase above scattered terms", () => {
    const { results } = searchFeatures(CATALOG, "request time off");
    expect(results[0]!.name).toMatch(/Request time off|time off request/);
  });

  it("searches aliases too", () => {
    const { results } = searchFeatures(CATALOG, "add absence type");
    expect(results[0]!.name).toBe("Create a new absence type");
  });

  it("falls back to partial matches when nothing matches everything", () => {
    const { results } = searchFeatures(CATALOG, "clock in during payroll");
    expect(results.length).toBeGreaterThan(0);
  });

  it("returns nothing for a query with no overlap at all", () => {
    expect(searchFeatures(CATALOG, "zzzz").results).toHaveLength(0);
  });

  it("reports how many matches it held back", () => {
    const many = Array.from({ length: 40 }, (_, i) => feature(`Approve time off ${i}`));
    const { results, truncated } = searchFeatures(many, "approve time off");
    expect(results).toHaveLength(25);
    expect(truncated).toBe(15);
  });
});

describe("slugify", () => {
  it("makes a readable id", () => {
    expect(slugify("Approve or reject a time off request")).toBe(
      "approve-or-reject-a-time-off-request",
    );
  });

  it.each([
    "Configure whether an absence type is deducted from the time off allowance",
    "Allow employees to request more time off days than available (negative counter)",
    "Configure timesheets to record actual hours worked instead of scheduled hours",
  ])("truncates %s at a word boundary, never mid-word", (name) => {
    const id = slugify(name);
    // The bug this guards: "...from-the-time-off-allowanc".
    expect(id.endsWith("-")).toBe(false);
    expect(id.length).toBeLessThanOrEqual(72);

    // Whole-word membership. Substring checks pass on "allowanc" vs
    // "allowance" and let the original bug through unnoticed.
    const sourceWords = new Set(
      name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/),
    );
    for (const word of id.split("-")) expect(sourceWords).toContain(word);
  });

  it("strips accents and punctuation", () => {
    expect(slugify("Añadir día festivo (opcional)")).toBe("anadir-dia-festivo-opcional");
  });

  it("falls back for input with nothing usable", () => {
    expect(slugify("!!!")).toBe("untitled");
    expect(slugify("")).toBe("untitled");
  });
});
