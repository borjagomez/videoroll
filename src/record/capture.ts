import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { launch, newContext } from "../browser.js";
import { installCursor } from "./cursor.js";
import { installTitleCard, hideTitleCard } from "./titlecard.js";
import { replay } from "./replay.js";
import { storageStatePath, rawVideoDir, ensureDir, rel } from "../paths.js";
import { probeVideo } from "../compose/ffmpeg.js";
import type { DemoScript, Narration, Timeline } from "../types.js";
import { log, dim, fmtDuration } from "../log.js";

/**
 * Still frames before navigation begins. Short, because the title card already
 * covers the opening - every millisecond here delays the app's boot behind it,
 * and the boot is what sets the intro's length.
 */
const LEAD_IN_MS = Number(process.env.VDG_LEAD_IN_MS ?? 250);
/** Hold on the final state so the outcome is readable before the cut. */
const TAIL_MS = Number(process.env.VDG_TAIL_MS ?? 1_200);
/**
 * Breathing room past the end of each narration line - the beat between one
 * sentence landing and the next starting. Around half a second matches how
 * people actually pause between sentences; much below that the delivery runs
 * together, much above and it reads as hesitation.
 */
const STEP_PADDING_MS = Number(process.env.VDG_STEP_PADDING_MS ?? 550);
/**
 * Minimum length of the opening card, measured from the first frame.
 *
 * The app boots behind the card, so the real intro lasts whichever is longer:
 * this, or however long the first screen took to draw. Holding this *on top of*
 * the boot instead produced an eighteen-second title on a fifty-second video.
 *
 * The floor has to outlast the title's entrance - delay plus rise, about 2.2s -
 * with enough left over to actually read it.
 */
const TITLE_MIN_MS = Number(process.env.VDG_TITLE_MS ?? 4_200);

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
    await installTitleCard(context, { title: script.featureName });

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
      // The card covers the app's boot; hold it a beat once the screen behind
      // it is ready, then fade. Step 1 begins on a drawn page, not a blank one.
      beforeFirstStep: async (page) => {
        const remaining = TITLE_MIN_MS - (Date.now() - origin);
        if (remaining > 0) await page.waitForTimeout(remaining);
        await hideTitleCard(page);
      },
      // Total time the step stays on screen, from its own start.
      holdMsFor: (step) => (byStep.get(step.id) ?? 2_000) + STEP_PADDING_MS,
      onStep: (step, index) => {
        if (index === 0) leadInMs = Date.now() - origin;
        log.detail(dim(`  ${index + 1}. ${step.caption}`));
      },
    });

    if (!result.ok) {
      const { step, message } = result.failure!;
      // A lapsed session looks exactly like a broken script - every locator
      // times out - so check before blaming the product for changing.
      const url = page.url();
      const expired = /\/(login|signin|sign_in|auth)\b/i.test(url);
      // This script verified against the live product minutes ago, so the
      // product changing under us is the least likely explanation. Far more
      // often the demo simply is not replayable: a third execution finds
      // nothing left to do, because the dates are booked, the request has been
      // approved, or - the subtle one - a form only offers Save once a value
      // actually changes, and the value is already what the script sets.
      throw new Error(
        `Recording stopped at step ${step.id} (${step.action}): ${message}\n` +
          (expired
            ? `  The session has expired - the browser is back at ${url}.\n` +
              `  Run \`vdg connect\` to sign in again, then retry.`
            : `  This script scouted and verified cleanly, so it is most likely ` +
              `not replayable: filming is its third run, and by now there may be ` +
              `nothing left to change.\n` +
              `  Record it with --one-pass, which films a single live run instead.`),
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

  // Keep only as much of the cover as the viewer needs; the rest was there to
  // hide the app booting and is a still frame.
  const trimStartMs = Math.max(0, leadInMs - TITLE_MIN_MS);
  const shift = (ms: number) => Math.max(0, ms + offset - trimStartMs);

  const timeline: Timeline = {
    slug: script.slug,
    videoFile: path.relative(path.dirname(videoDir), videoPath),
    width: info.width || size.width,
    height: info.height || size.height,
    leadInMs: Math.max(0, Math.min(leadInMs, TITLE_MIN_MS) + offset),
    trimStartMs,
    tailMs: TAIL_MS,
    totalMs: Math.max(0, info.durationMs - trimStartMs),
    entries: timings.map((t) => ({
      stepId: t.stepId,
      startMs: shift(t.startMs),
      endMs: shift(t.endMs),
    })),
  };

  if (trimStartMs > 0) {
    log.detail(
      dim(`  trimming ${fmtDuration(trimStartMs)} of cover that only hid the app booting`),
    );
  }

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
