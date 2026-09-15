import { describe, it, expect } from "vitest";
import { deriveLocator, type SnapshotElement } from "./snapshot.js";
import { describe as describeLocator } from "./locator.js";
import { DemoScriptSchema, LocatorSchema } from "../types.js";

function element(overrides: Partial<SnapshotElement> = {}): SnapshotElement {
  return {
    ref: "e1",
    role: "button",
    name: "Approve",
    tag: "button",
    disabled: false,
    roleNameIndex: 0,
    cssPath: "div > button:nth-of-type(1)",
    unique: { roleName: true, label: false, placeholder: false, text: false, testid: false },
    ...overrides,
  };
}

describe("deriveLocator", () => {
  it("prefers a unique role and name", () => {
    expect(deriveLocator(element())).toEqual({
      kind: "role",
      role: "button",
      name: "Approve",
      exact: true,
    });
  });

  it("indexes rather than downgrading when role+name repeats", () => {
    const locator = deriveLocator(
      element({
        roleNameIndex: 2,
        testid: "approve-3",
        unique: {
          roleName: false,
          label: false,
          placeholder: false,
          text: false,
          testid: true,
        },
      }),
    );
    // An nth-of-role locator outlives a testid the team may rename.
    expect(locator).toEqual({
      kind: "role",
      role: "button",
      name: "Approve",
      exact: true,
      nth: 2,
    });
  });

  it("falls back to the label for an unnamed field", () => {
    expect(
      deriveLocator(
        element({
          role: "textbox",
          name: "",
          tag: "textarea",
          labelText: "Note for the employee",
          unique: {
            roleName: false,
            label: true,
            placeholder: false,
            text: false,
            testid: false,
          },
        }),
      ),
    ).toEqual({ kind: "label", name: "Note for the employee", exact: true });
  });

  it("uses the placeholder when there is no label", () => {
    expect(
      deriveLocator(
        element({
          role: "textbox",
          name: "",
          placeholder: "Search people",
          unique: {
            roleName: false,
            label: false,
            placeholder: true,
            text: false,
            testid: false,
          },
        }),
      ).kind,
    ).toBe("placeholder");
  });

  it("uses a testid before raw text", () => {
    expect(
      deriveLocator(
        element({
          role: "generic",
          name: "",
          testid: "row-actions",
          text: "Approve",
          unique: {
            roleName: false,
            label: false,
            placeholder: false,
            text: true,
            testid: true,
          },
        }),
      ),
    ).toEqual({ kind: "testid", value: "row-actions" });
  });

  it("uses a css path only when nothing else identifies the element", () => {
    expect(
      deriveLocator(
        element({
          role: "generic",
          name: "",
          unique: {
            roleName: false,
            label: false,
            placeholder: false,
            text: false,
            testid: false,
          },
        }),
      ),
    ).toEqual({ kind: "css", selector: "div > button:nth-of-type(1)" });
  });

  it("never emits a locator the schema rejects", () => {
    const cases = [
      element(),
      element({ roleNameIndex: 1, unique: { ...element().unique, roleName: false } }),
      element({ role: "generic", name: "", unique: { roleName: false, label: false, placeholder: false, text: false, testid: false } }),
    ];
    for (const candidate of cases) {
      expect(LocatorSchema.safeParse(deriveLocator(candidate)).success).toBe(true);
    }
  });
});

describe("describe", () => {
  it("renders each kind readably", () => {
    expect(describeLocator({ kind: "role", role: "button", name: "Approve" })).toBe(
      'button "Approve"',
    );
    expect(describeLocator({ kind: "role", role: "button", name: "Approve", nth: 2 })).toBe(
      'button "Approve" #2',
    );
    expect(describeLocator({ kind: "testid", value: "row-1" })).toBe("testid row-1");
    expect(describeLocator({ kind: "css", selector: "main > div" })).toBe("css main > div");
  });
});

describe("DemoScriptSchema", () => {
  const base = {
    slug: "approve-time-off",
    request: "approve a time off request",
    featureName: "Approve a time off request",
    product: "acme",
    profile: "demo",
    startUrl: "http://localhost:4174/app.html",
    createdAt: "2026-09-15T00:00:00.000Z",
    steps: [
      {
        id: 1,
        action: "click",
        locator: { kind: "role", role: "link", name: "Time off" },
        narration: "We start in the Time off section.",
        caption: "Open Time off",
      },
    ],
  };

  it("fills in the defaults a scout may omit", () => {
    const parsed = DemoScriptSchema.parse(base);
    expect(parsed.steps[0]!.settleMs).toBe(800);
    expect(parsed.steps[0]!.highlight).toBe(true);
    expect(parsed.divergences).toEqual([]);
  });

  it("rejects a script with no steps", () => {
    expect(DemoScriptSchema.safeParse({ ...base, steps: [] }).success).toBe(false);
  });

  it("rejects a non-URL start", () => {
    expect(DemoScriptSchema.safeParse({ ...base, startUrl: "app.html" }).success).toBe(false);
  });

  it("rejects an unknown action", () => {
    const steps = [{ ...base.steps[0], action: "teleport" }];
    expect(DemoScriptSchema.safeParse({ ...base, steps }).success).toBe(false);
  });
});
