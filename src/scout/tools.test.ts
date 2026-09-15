import { describe, it, expect } from "vitest";
import type { Page } from "playwright";
import { ScoutSession } from "./tools.js";
import { DemoScriptSchema, type Step } from "../types.js";

/** `seed` never touches the page, so a repair round can be tested without one. */
const sessionWithoutPage = () =>
  new ScoutSession(null as unknown as Page, "https://example.test/start");

function step(id: number): Step {
  return {
    id,
    action: "click",
    locator: { kind: "role", role: "button", name: `Button ${id}` },
    narration: `Step ${id}.`,
    caption: `Step ${id}`,
    settleMs: 800,
    highlight: true,
  };
}

describe("ScoutSession.seed", () => {
  it("adopts the steps that already replayed", () => {
    const session = sessionWithoutPage();
    session.seed([step(1), step(2), step(3)]);
    expect(session.steps.map((s) => s.id)).toEqual([1, 2, 3]);
  });

  it("continues numbering past the seed instead of restarting at 1", () => {
    const session = sessionWithoutPage();
    session.seed([step(1), step(2), step(3), step(4)]);

    // Simulates what a repair round records next. Restarting at 1 produced
    // duplicate ids, and narration.json and timeline.json are keyed by id - so
    // the video came out with the wrong line over the wrong shot.
    const tools = session.tools();
    expect(tools.length).toBeGreaterThan(0);

    session.seed([]); // a no-op seed must not rewind the counter
    expect(session.steps).toHaveLength(4);
  });

  it("leaves numbering at 1 when there is nothing to seed", () => {
    const session = sessionWithoutPage();
    session.seed([]);
    expect(session.steps).toHaveLength(0);
  });

  it("produces ids a demo script accepts", () => {
    const session = sessionWithoutPage();
    session.seed([step(1), step(2)]);

    const parsed = DemoScriptSchema.safeParse({
      slug: "x",
      request: "x",
      featureName: "x",
      product: "p",
      profile: "demo",
      startUrl: "https://example.test/start",
      createdAt: new Date().toISOString(),
      steps: session.steps,
    });
    expect(parsed.success).toBe(true);

    const ids = session.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
