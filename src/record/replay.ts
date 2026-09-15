import type { Page } from "playwright";
import { resolve, describe } from "../scout/locator.js";
import { moveCursor, rippleAt, highlight, ensureCursor, placeCursor } from "./cursor.js";
import type { Step } from "../types.js";
import { log, dim } from "../log.js";

/** A step that did not do what it said, but must not stop the run. */
export class SoftStepError extends Error {}

export interface StepTiming {
  stepId: number;
  startMs: number;
  endMs: number;
}

export interface ReplayResult {
  ok: boolean;
  timings: StepTiming[];
  /** Wait steps whose text never appeared. Reported, never fatal. */
  softFailures: string[];
  /** Set when a step failed; the rest were not attempted. */
  failure?: { step: Step; index: number; message: string };
}

export interface ReplayOptions {
  page: Page;
  steps: Step[];
  startUrl: string;
  /** Draw the synthetic cursor and highlights. Off for plain verification. */
  cinematic?: boolean;
  /** How long to hold on each step once its action is done. */
  holdMsFor?: (step: Step, index: number) => number;
  /** Called with the offset, in ms from replay start, at which each step begins. */
  onStep?: (step: Step, index: number, startMs: number) => void;
  /** Wall-clock origin for reported timings; defaults to replay start. */
  startedAt?: number;
}

const CURSOR_TRAVEL_MS = 520;

/**
 * Where on an element the pointer should land.
 *
 * Purely cosmetic, and measuring it races with the app: a React re-render
 * between locating and measuring detaches the node. Never let that fail a
 * take - the click that follows re-resolves the locator by itself.
 */
async function targetPoint(page: Page, step: Step) {
  if (!step.locator) return null;
  const locator = resolve(page, step.locator);
  const box = await locator.boundingBox({ timeout: 8_000 }).catch(() => null);
  if (!box) return null;
  return {
    point: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    rect: box,
  };
}

async function runStep(page: Page, step: Step, cinematic: boolean): Promise<void> {
  if (step.action === "navigate") {
    if (!step.url) throw new Error("navigate step has no url");
    await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (cinematic) {
      await ensureCursor(page);
      // A fresh document loses the drawn cursor; put it back where it was so
      // the next move reads as continuous motion rather than a jump.
      await placeCursor(page, { x: 140, y: 140 });
    }
    return;
  }

  if (step.action === "wait") {
    if (!step.waitForText) throw new Error("wait step has no waitForText");
    // Best-effort by design. A wait asserts on transient UI - a toast, a
    // "Saved" flash - which may well have expired while the previous step was
    // held for its narration. That is a timing nuance, not a broken script, so
    // it must not be able to fail a recording that otherwise worked.
    try {
      await page.getByText(step.waitForText).first().waitFor({ timeout: 8_000 });
    } catch {
      throw new SoftStepError(`"${step.waitForText}" was not visible`);
    }
    return;
  }

  if (!step.locator) throw new Error(`${step.action} step has no locator`);
  const locator = resolve(page, step.locator);
  await locator.waitFor({ state: "visible", timeout: 15_000 });
  // Tolerated, not required: an SPA can re-render between locating and
  // scrolling, detaching the node. Every action below re-resolves the locator
  // and scrolls on its own, so a failure here costs nothing but a nicety.
  await locator.scrollIntoViewIfNeeded({ timeout: 8_000 }).catch(() => undefined);

  if (cinematic) {
    const target = await targetPoint(page, step);
    if (target) {
      if (step.highlight) await highlight(page, target.rect);
      await moveCursor(page, target.point, CURSOR_TRAVEL_MS);
      await page.waitForTimeout(140);
    }
  }

  switch (step.action) {
    case "click":
      if (cinematic) await rippleAt(page);
      await locator.click({ timeout: 15_000 });
      break;
    case "fill":
      if (cinematic) {
        // Typing character by character reads as a person filling the form;
        // fill() would make the text appear all at once.
        await locator.click({ timeout: 15_000 });
        await locator.fill("");
        await locator.pressSequentially(step.value ?? "", { delay: 45 });
      } else {
        await locator.fill(step.value ?? "", { timeout: 15_000 });
      }
      break;
    case "select":
      await locator.selectOption({ label: step.value ?? "" }, { timeout: 15_000 });
      break;
    case "press":
      await locator.press(step.value ?? "Enter", { timeout: 15_000 });
      break;
    case "hover":
      await locator.hover({ timeout: 15_000 });
      break;
    case "scroll":
      await locator.scrollIntoViewIfNeeded({ timeout: 8_000 });
      break;
    default:
      throw new Error(`Unsupported action: ${step.action}`);
  }

  if (cinematic && step.highlight) await highlight(page, null);
}

/**
 * Executes a steps.json against a live page. The same function both verifies a
 * script (cinematic off, no holds) and records one (cinematic on, holds driven
 * by narration length) - so what the scout verified is exactly what the camera
 * later sees.
 */
export async function replay(options: ReplayOptions): Promise<ReplayResult> {
  const { page, steps, cinematic = false } = options;
  const origin = options.startedAt ?? Date.now();
  const timings: StepTiming[] = [];
  const softFailures: string[] = [];

  await page.goto(options.startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (cinematic) {
    await ensureCursor(page);
    await placeCursor(page, { x: 140, y: 140 });
  }
  await page.waitForTimeout(400);

  for (const [index, step] of steps.entries()) {
    const startMs = Date.now() - origin;
    options.onStep?.(step, index, startMs);

    try {
      await runStep(page, step, cinematic);
    } catch (error) {
      if (!(error instanceof SoftStepError)) {
        return {
          ok: false,
          timings,
          softFailures,
          failure: {
            step,
            index,
            message: (error as Error).message.split("\n")[0] ?? String(error),
          },
        };
      }
      softFailures.push(`step ${step.id}: ${error.message}`);
      log.warn(dim(`step ${step.id}: ${error.message} — continuing`));
    }

    await page.waitForTimeout(step.settleMs);
    const hold = options.holdMsFor?.(step, index) ?? 0;
    const remaining = hold - step.settleMs;
    if (remaining > 0) await page.waitForTimeout(remaining);

    timings.push({ stepId: step.id, startMs, endMs: Date.now() - origin });
    log.detail(
      dim(
        `  ${index + 1}/${steps.length} ${step.action}` +
          (step.locator ? ` ${describe(step.locator)}` : "") +
          ` ${Math.round((timings.at(-1)!.endMs - startMs) / 100) / 10}s`,
      ),
    );
  }

  return { ok: true, timings, softFailures };
}
