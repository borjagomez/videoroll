import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { launch, newContext } from "../browser.js";
import { installCursor } from "./cursor.js";
import { replay } from "./replay.js";
import { storageStatePath, rawVideoDir, ensureDir, rel } from "../paths.js";
import { probeVideo } from "../compose/ffmpeg.js";
import type { DemoScript, Narration, Timeline } from "../types.js";
import { log, dim, fmtDuration } from "../log.js";

/** Still frames before the first action, so the video does not open mid-move. */
const LEAD_IN_MS = 1_200;
/** Hold on the final state so the outcome is readable before the cut. */
const TAIL_MS = 1_800;
/** Breathing room added to every step on top of its narration. */
const STEP_PADDING_MS = 450;

export interface CaptureOptions {
  script: DemoScript;
  narration: Narration;
  headed?: boolean;
}

export interface CaptureResult {
  timeline: Timeline;
  videoPath: string;
}

/**
 * Replays the verified script in front of Playwright's video recorder.
 *
 * Audio and video stay in sync by construction rather than by detection: each
 * step is held on screen for exactly as long as its narration clip runs, and
 * `compose` later lays those same clips down at the offsets recorded here. The
 * only unknown is the few milliseconds between page creation and the first
 * encoded frame, which VDG_AV_OFFSET_MS can nudge if a project needs it.
 */
export async function capture(options: CaptureOptions): Promise<CaptureResult> {
  const { script, narration } = options;
  const byStep = new Map(narration.steps.map((s) => [s.stepId, s.durationMs]));

  const videoDir = ensureDir(rawVideoDir(script.slug));
  for (const stale of fs.readdirSync(videoDir)) {
    fs.rmSync(path.join(videoDir, stale), { force: true });
  }

  const size = { width: config.video.width, height: config.video.height };
  const browser = await launch(!options.headed);

  let videoPath: string;
  let timings: Awaited<ReturnType<typeof replay>>["timings"] = [];
  let leadInMs = LEAD_IN_MS;
  let measuredEndMs = 0;

  try {
    const context = await newContext(browser, {
      storageStatePath: storageStatePath(script.profile),
      viewport: size,
      deviceScaleFactor: config.video.deviceScaleFactor,
      recordVideo: { dir: videoDir, size },
    });
    await installCursor(context);

    // Recording starts with the page, so this is the video's time origin.
    const origin = Date.now();
    const page = await context.newPage();
    await page.waitForTimeout(LEAD_IN_MS);

    log.step(`Recording ${script.steps.length} steps at ${size.width}×${size.height}`);
    const result = await replay({
      page,
      steps: script.steps,
      startUrl: script.startUrl,
      cinematic: true,
      startedAt: origin,
      holdMsFor: (step) => (byStep.get(step.id) ?? 2_000) + STEP_PADDING_MS,
      onStep: (step, index) => {
        if (index === 0) leadInMs = Date.now() - origin;
        log.detail(dim(`  ${index + 1}. ${step.caption}`));
      },
    });

    if (!result.ok) {
      const { step, message } = result.failure!;
      throw new Error(
        `Recording stopped at step ${step.id} (${step.action}): ${message}\n` +
          `  The script verified earlier, so the demo environment has probably ` +
          `changed. Re-run \`vdg record\` to re-scout it.`,
      );
    }

    timings = result.timings;
    measuredEndMs = timings.at(-1)?.endMs ?? 0;

    await page.waitForTimeout(TAIL_MS);
    const video = page.video();
    await context.close(); // flushes the webm
    if (!video) throw new Error("Playwright recorded no video for this page.");
    videoPath = await video.path();
  } finally {
    await browser.close();
  }

  const info = await probeVideo(videoPath);
  const offset = Number(process.env.VDG_AV_OFFSET_MS ?? 0);

  const timeline: Timeline = {
    slug: script.slug,
    videoFile: path.relative(path.dirname(videoDir), videoPath),
    width: info.width || size.width,
    height: info.height || size.height,
    leadInMs: Math.max(0, leadInMs + offset),
    tailMs: TAIL_MS,
    totalMs: info.durationMs,
    entries: timings.map((t) => ({
      stepId: t.stepId,
      startMs: Math.max(0, t.startMs + offset),
      endMs: Math.max(0, t.endMs + offset),
    })),
  };

  log.ok(
    `Captured ${fmtDuration(info.durationMs)} → ${rel(videoPath)} ` +
      dim(`(${info.width}×${info.height})`),
  );
  // A second or so of difference is the recorder starting and flushing, and it
  // sits at the tail where nothing is keyed to it. Only a large gap suggests
  // the offsets themselves are wrong.
  const drift = info.durationMs - (measuredEndMs + TAIL_MS);
  if (Math.abs(drift) > 3_000) {
    log.warn(
      `The video runs ${fmtDuration(Math.abs(drift))} ${drift > 0 ? "longer" : "shorter"} ` +
        `than the steps measured. If narration and picture drift apart, set ` +
        `VDG_AV_OFFSET_MS to shift the audio.`,
    );
  }

  return { timeline, videoPath };
}
