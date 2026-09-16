import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Page } from "playwright";
import { captureSnapshot, deriveLocator, refSelector, type Snapshot } from "./snapshot.js";
import { describe } from "./locator.js";
import { settle } from "../browser.js";
import { moveCursor, rippleAt, highlight } from "../record/cursor.js";
import { typeInto } from "../record/typing.js";
import type { Step, StepAction } from "../types.js";
import { log, dim } from "../log.js";

/** The slice of recording that shows one step, relative to the video's start. */
export interface StepSegment {
  stepId: number;
  startMs: number;
  endMs: number;
}

export interface ScoutSessionOptions {
  /** Animate the pointer and mark each segment - for a one-pass recording. */
  cinematic?: boolean;
  /** Wall-clock instant the video began, so segments can be expressed against it. */
  videoOrigin?: number;
}

/**
 * How many actions may change nothing before the run is called off.
 *
 * High enough that the model can try two or three ways round an obstacle -
 * clicking the label, then the input, then a different control - and low
 * enough that it cannot spend fifty turns doing it.
 */
export const STALL_LIMIT = 8;

/**
 * Score one action against the stall counter.
 *
 * Recording a step is progress by definition. Changing the screen is progress
 * too even when the model is only exploring - it opened a menu, it moved to
 * another tab, it learned something. An action that does neither taught nobody
 * anything, and a run of them means the model is pressing something that does
 * not answer.
 */
export function countStall(
  previous: number,
  outcome: { recorded: boolean; screenChanged: boolean },
): number {
  return outcome.recorded || outcome.screenChanged ? 0 : previous + 1;
}

/**
 * Holds everything one scouting run mutates: the live page, the latest
 * snapshot, and the script being assembled.
 *
 * The important design choice is that the model works in *refs* while the
 * durable locator is derived in code from the same snapshot. The model chooses
 * which element to act on; it never chooses how that element will be found
 * again tomorrow.
 */
export class ScoutSession {
  readonly steps: Step[] = [];
  readonly divergences: string[] = [];
  /**
   * When to cut. In a one-pass recording the camera runs through the whole
   * session, exploration included; these windows are the only parts that
   * belong in the finished video.
   */
  readonly segments: StepSegment[] = [];
  finished = false;
  summary = "";

  private snapshot: Snapshot | null = null;
  private nextId = 1;
  private actionStartedAt = 0;
  private deadActions = 0;
  private lastScreen = "";
  private lastAttempt = "";

  constructor(
    private readonly page: Page,
    readonly startUrl: string,
    private readonly options: ScoutSessionOptions = {},
  ) {}

  private get cinematic(): boolean {
    return this.options.cinematic === true;
  }

  /**
   * The scout is fighting something it cannot operate.
   *
   * An action that records a step, or that changes the screen, is progress even
   * when the model is still exploring. Neither of those, several times running,
   * means the same thing every time it has happened: a control that does not
   * respond the way the model expects - a masked time field, a button that
   * stays disabled, a dialog that will not close. Left alone the model will
   * spend its entire iteration budget there and finish with nothing, which is
   * both the expensive failure and the slow one.
   */
  get stalled(): boolean {
    return this.deadActions >= STALL_LIMIT;
  }

  /** The last thing the scout tried, so a stall can say what it died on. */
  get stalledOn(): string {
    return this.lastAttempt;
  }

  /** Marks the instant a tool began acting, so its segment starts there. */
  private beginAction(): void {
    this.actionStartedAt = Date.now();
  }

  /**
   * Move the drawn pointer onto the target before acting, exactly as the
   * deterministic recorder does, so a one-pass take looks like a replayed one.
   */
  private async approach(ref: string): Promise<void> {
    if (!this.cinematic) return;
    const box = await this.page
      .locator(refSelector(ref))
      .boundingBox({ timeout: 6_000 })
      .catch(() => null);
    if (!box) return;
    await highlight(this.page, box);
    await moveCursor(
      this.page,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      380,
    );
    await this.page.waitForTimeout(90);
  }

  private async afterAction(): Promise<void> {
    if (this.cinematic) await highlight(this.page, null);
  }

  /**
   * Adopt steps that already replay cleanly, for a repair round.
   *
   * Numbering has to continue past them. Pushing the steps without advancing
   * the counter restarts ids at 1, and the duplicates then collide in
   * narration.json and timeline.json, which are both keyed by step id - the
   * video still renders, with the wrong line over the wrong shot.
   */
  seed(steps: Step[]): void {
    this.steps.push(...steps);
    this.nextId = steps.reduce((max, step) => Math.max(max, step.id), 0) + 1;
  }

  private async refresh(): Promise<string> {
    // Let the app react before describing it. A fixed short pause is not
    // enough for a real SPA - Factorial's screens are still blank a second
    // after navigation - and a snapshot taken mid-transition teaches the model
    // a screen that never existed.
    await settle(this.page, { minMs: 400, maxMs: 10_000 });
    this.snapshot = await captureSnapshot(this.page);
    return this.snapshot.text;
  }

  private element(ref: string) {
    const element = this.snapshot?.byRef.get(ref);
    if (!element) {
      throw new Error(
        `No element ${ref} in the current snapshot. Refs are only valid for the ` +
          `snapshot they came from - call snapshot and use a ref from it.`,
      );
    }
    return element;
  }

  private record(
    action: StepAction,
    options: {
      narration: string;
      caption: string;
      locator?: Step["locator"];
      url?: string;
      value?: string;
      waitForText?: string;
      note?: string;
    },
  ): void {
    const step: Step = {
      id: this.nextId++,
      action,
      narration: options.narration.trim(),
      caption: options.caption.trim(),
      settleMs: 800,
      highlight: action !== "navigate" && action !== "wait",
      ...(options.locator ? { locator: options.locator } : {}),
      ...(options.url ? { url: options.url } : {}),
      ...(options.value !== undefined ? { value: options.value } : {}),
      ...(options.waitForText ? { waitForText: options.waitForText } : {}),
      ...(options.note ? { note: options.note } : {}),
    };
    this.steps.push(step);
    if (this.options.videoOrigin !== undefined) {
      const origin = this.options.videoOrigin;
      this.segments.push({
        stepId: step.id,
        startMs: Math.max(0, (this.actionStartedAt || Date.now()) - origin),
        endMs: Date.now() - origin,
      });
    }
    log.detail(
      dim(
        `  step ${step.id}: ${action}` +
          (step.locator ? ` ${describe(step.locator)}` : "") +
          (step.url ? ` ${step.url}` : ""),
      ),
    );
  }

  /** Shared tail on every action result so the model always sees the outcome. */
  private async outcome(what: string, recorded: boolean): Promise<string> {
    const snapshot = await this.refresh();
    // The screen has now settled, so the shot for the step just recorded runs
    // to here - not to the instant the click returned.
    const last = this.segments.at(-1);
    if (recorded && last && this.options.videoOrigin !== undefined) {
      last.endMs = Date.now() - this.options.videoOrigin;
    }
    this.deadActions = countStall(this.deadActions, {
      recorded,
      screenChanged: snapshot !== this.lastScreen,
    });
    this.lastScreen = snapshot;
    this.lastAttempt = what;

    const tag = recorded ? "recorded" : "not recorded (exploring)";
    return `${what} — ${tag}.\n\n${snapshot}`;
  }

  tools() {
    const RECORD = z
      .boolean()
      .describe(
        "true to add this action to the demo script, false while exploring. " +
          "Only record actions that belong in the finished demo.",
      );
    const NARRATION = z
      .string()
      .describe(
        "What the voiceover says while this happens. One natural sentence " +
          "addressed to the viewer. Ignored when record is false.",
      );
    const CAPTION = z
      .string()
      .describe("Two to five words for the on-screen label. Ignored when record is false.");

    return [
      betaZodTool({
        name: "snapshot",
        description:
          "Describe what is on screen right now: the URL, headings, any status " +
          "message, and every interactive element with a [ref] you can act on.",
        inputSchema: z.object({}),
        run: async () => this.refresh(),
      }),

      betaZodTool({
        name: "screenshot",
        description:
          "Look at the page as an image. Use this when the snapshot is ambiguous " +
          "or you need to judge layout; the snapshot is cheaper for everything else.",
        inputSchema: z.object({}),
        run: async () => {
          const buffer = await this.page.screenshot({ type: "png", scale: "css" });
          return [
            {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: "image/png" as const,
                data: buffer.toString("base64"),
              },
            },
          ];
        },
      }),

      betaZodTool({
        name: "navigate",
        description: "Go to a URL.",
        inputSchema: z.object({
          url: z.string().describe("Absolute URL"),
          record: RECORD,
          narration: NARRATION,
          caption: CAPTION,
        }),
        run: async ({ url, record, narration, caption }) => {
          this.beginAction();
          await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          if (record) this.record("navigate", { url, narration, caption });
          return this.outcome(`Navigated to ${url}`, record);
        },
      }),

      betaZodTool({
        name: "click",
        description:
          "Click an element from the current snapshot. This is how you open " +
          "screens, submit forms and press buttons.",
        inputSchema: z.object({
          ref: z.string().describe("A [ref] from the current snapshot, e.g. e12"),
          record: RECORD,
          narration: NARRATION,
          caption: CAPTION,
        }),
        run: async ({ ref, record, narration, caption }) => {
          const element = this.element(ref);
          this.beginAction();
          await this.approach(ref);
          if (this.cinematic) await rippleAt(this.page);
          await this.page.locator(refSelector(ref)).click({ timeout: 10_000 });
          await this.afterAction();
          if (record) {
            this.record("click", {
              narration,
              caption,
              locator: deriveLocator(element),
              note: element.context,
            });
          }
          return this.outcome(`Clicked ${element.role} "${element.name}"`, record);
        },
      }),

      betaZodTool({
        name: "fill",
        description: "Type into a text field, replacing whatever is there.",
        inputSchema: z.object({
          ref: z.string().describe("A [ref] from the current snapshot"),
          value: z.string().describe("Text to type. Use realistic demo content."),
          record: RECORD,
          narration: NARRATION,
          caption: CAPTION,
        }),
        run: async ({ ref, value, record, narration, caption }) => {
          const element = this.element(ref);
          this.beginAction();
          await this.approach(ref);
          const field = this.page.locator(refSelector(ref));
          // Typed, not pasted - the same reading as the deterministic recorder.
          await typeInto(field, value, {
            cinematic: this.cinematic,
            timeout: 10_000,
          });
          await this.afterAction();
          if (record) {
            this.record("fill", {
              narration,
              caption,
              value,
              locator: deriveLocator(element),
            });
          }
          return this.outcome(`Typed "${value}" into "${element.name}"`, record);
        },
      }),

      betaZodTool({
        name: "select",
        description: "Choose an option in a dropdown.",
        inputSchema: z.object({
          ref: z.string().describe("A [ref] for a select element"),
          value: z.string().describe("The option's visible label"),
          record: RECORD,
          narration: NARRATION,
          caption: CAPTION,
        }),
        run: async ({ ref, value, record, narration, caption }) => {
          const element = this.element(ref);
          this.beginAction();
          await this.approach(ref);
          await this.page
            .locator(refSelector(ref))
            .selectOption({ label: value }, { timeout: 10_000 });
          await this.afterAction();
          if (record) {
            this.record("select", {
              narration,
              caption,
              value,
              locator: deriveLocator(element),
            });
          }
          return this.outcome(`Selected "${value}" in "${element.name}"`, record);
        },
      }),

      betaZodTool({
        name: "press",
        description:
          "Press a key, optionally focused on an element. Use for Enter, Escape, Tab.",
        inputSchema: z.object({
          key: z.string().describe("Playwright key name, e.g. Enter, Escape, Tab"),
          ref: z.string().optional().describe("Focus this element first"),
          record: RECORD,
          narration: NARRATION,
          caption: CAPTION,
        }),
        run: async ({ key, ref, record, narration, caption }) => {
          const element = ref ? this.element(ref) : null;
          this.beginAction();
          if (ref) await this.approach(ref);
          if (ref) await this.page.locator(refSelector(ref)).press(key, { timeout: 10_000 });
          else await this.page.keyboard.press(key);
          if (record) {
            this.record("press", {
              narration,
              caption,
              value: key,
              ...(element ? { locator: deriveLocator(element) } : {}),
            });
          }
          return this.outcome(`Pressed ${key}`, record);
        },
      }),

      betaZodTool({
        name: "wait_for",
        description:
          "Wait until some text appears. Use after an action that saves or loads, " +
          "so the demo pauses on the confirmation instead of cutting away from it.",
        inputSchema: z.object({
          text: z.string().describe("Text that should become visible"),
          record: RECORD,
          narration: NARRATION,
          caption: CAPTION,
        }),
        run: async ({ text, record, narration, caption }) => {
          this.beginAction();
          try {
            await this.page.getByText(text).first().waitFor({ timeout: 10_000 });
          } catch {
            return this.outcome(`"${text}" did not appear within 10s`, false);
          }
          if (record) {
            this.record("wait", { narration, caption, waitForText: text });
          }
          return this.outcome(`"${text}" is visible`, record);
        },
      }),

      betaZodTool({
        name: "note_divergence",
        description:
          "Record that the live product differs from what the documentation said. " +
          "This is reported to the user; it does not change the demo.",
        inputSchema: z.object({
          note: z.string().describe("What the docs claimed and what you actually found"),
        }),
        run: async ({ note }) => {
          this.divergences.push(note);
          return "Noted.";
        },
      }),

      betaZodTool({
        name: "drop_last_step",
        description:
          "Remove the step you just recorded, if you recorded something that does " +
          "not belong in the demo.",
        inputSchema: z.object({}),
        run: async () => {
          const dropped = this.steps.pop();
          if (dropped) this.nextId--;
          return dropped
            ? `Dropped step ${dropped.id} (${dropped.action}).`
            : "There are no recorded steps to drop.";
        },
      }),

      betaZodTool({
        name: "finish",
        description:
          "Call this once the demo is complete and you have recorded every step " +
          "a viewer needs to see.",
        inputSchema: z.object({
          summary: z
            .string()
            .describe("One or two sentences on what the finished demo shows"),
        }),
        run: async ({ summary }) => {
          this.finished = true;
          this.summary = summary;
          return `Recorded ${this.steps.length} steps. Scouting complete.`;
        },
      }),
    ];
  }
}
