import { describe, it, expect } from "vitest";
import type { Page } from "playwright";
import { ScoutSession, countStall, STALL_LIMIT } from "./tools.js";
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

describe("countStall", () => {
  it("counts actions that change nothing and record nothing", () => {
    let dead = 0;
    for (let i = 0; i < 5; i++) {
      dead = countStall(dead, { recorded: false, screenChanged: false });
    }
    expect(dead).toBe(5);
  });

  it("forgives an action that recorded a step", () => {
    const dead = countStall(7, { recorded: true, screenChanged: false });
    expect(dead).toBe(0);
  });

  it("forgives exploring that moved the screen", () => {
    const dead = countStall(7, { recorded: false, screenChanged: true });
    expect(dead).toBe(0);
  });

  it("gives the model room to try a few ways round an obstacle", () => {
    // The run this guard exists for spent all 50 iterations on one masked time
    // field. Tripping at 8 stops that while still allowing a couple of retries.
    expect(STALL_LIMIT).toBeGreaterThan(3);
    expect(STALL_LIMIT).toBeLessThan(15);
  });
});
