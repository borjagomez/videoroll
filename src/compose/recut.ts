import path from "node:path";
import { ffmpeg, probeVideo } from "./ffmpeg.js";
import { ensureDir, rawVideoDir } from "../paths.js";
import type { StepSegment } from "../scout/tools.js";
import type { Narration, Timeline } from "../types.js";
import { log, dim, fmtDuration } from "../log.js";

/** Gap left between shots, matching the deterministic recorder's pacing. */
const SEGMENT_PADDING_MS = Number(process.env.VDG_STEP_PADDING_MS ?? 250);
/** Opening card, taken from the head of the recording. */
const INTRO_MS = Number(process.env.VDG_TITLE_MS ?? 3_000);

export interface RecutOptions {
  slug: string;
  /** The raw recording of the whole scouting session. */
  sourceVideo: string;
  /** Windows of that recording which show a recorded step, in order. */
  segments: StepSegment[];
  narration: Narration;
  /** Seconds at the head of the source showing the title card. */
  introMs?: number;
}

export interface RecutResult {
  videoPath: string;
  timeline: Timeline;
}

const secs = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3);

/**
 * Cut a one-pass recording down to the demo.
 *
 * The camera runs for the whole scouting session, so the raw file contains
 * every wrong turn and dead end the model took on its way to the working path.
 * Only the windows it marked as recorded steps belong in the video, and each
 * has to last as long as its narration line - actions are usually quicker than
 * the sentence describing them, so the last frame of each shot is held to fill
 * the difference rather than rushing the voice.
 *
 * This is what makes a single execution enough. The alternative - scout, then
 * verify, then film - runs the demo three times, which no feature that consumes
 * a date, a quota or a queue position can survive.
 */
export async function recut(options: RecutOptions): Promise<RecutResult> {
  const { slug, sourceVideo, segments, narration } = options;
  if (segments.length === 0) {
    throw new Error("Nothing to cut: the scout marked no steps as recorded.");
  }

  const durationByStep = new Map(narration.steps.map((s) => [s.stepId, s.durationMs]));
  const source = await probeVideo(sourceVideo);
  const introMs = Math.min(options.introMs ?? INTRO_MS, source.durationMs);

  const filters: string[] = [];
  const labels: string[] = [];
  const entries: Timeline["entries"] = [];
  let offsetMs = 0;

  if (introMs > 0) {
    filters.push(
      `[0:v]trim=start=0:end=${secs(introMs)},setpts=PTS-STARTPTS[v_intro]`,
    );
    labels.push("[v_intro]");
    offsetMs += introMs;
  }

  for (const [index, segment] of segments.entries()) {
    const availableMs = Math.max(600, segment.endMs - segment.startMs);
    const spokenMs = durationByStep.get(segment.stepId) ?? 2_000;
    const targetMs = spokenMs + SEGMENT_PADDING_MS;

    // Every shot lasts exactly as long as its line, taken from the *start* of
    // the window where the action happens. A recorded window can run far longer
    // than that - it ends when the model has finished looking at the result,
    // and the last one ends when the whole session does - so without this cap a
    // four-second line sat over twenty seconds of a motionless screen.
    const useMs = Math.min(availableMs, targetMs);
    // Freeze the final frame rather than slowing the footage: stretched video
    // reads as a glitch, a held frame reads as a pause.
    const padMs = targetMs - useMs;

    filters.push(
      `[0:v]trim=start=${secs(segment.startMs)}:end=${secs(segment.startMs + useMs)},` +
        `setpts=PTS-STARTPTS` +
        (padMs > 0 ? `,tpad=stop_mode=clone:stop_duration=${secs(padMs)}` : "") +
        `[v${index}]`,
    );
    labels.push(`[v${index}]`);

    entries.push({
      stepId: segment.stepId,
      startMs: offsetMs,
      endMs: offsetMs + targetMs,
    });
    offsetMs += targetMs;
  }

  filters.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0[vout]`);

  const outDir = ensureDir(rawVideoDir(slug));
  const videoPath = path.join(outDir, "recut.mp4");

  log.step(
    `Cutting ${segments.length} shots out of ${fmtDuration(source.durationMs)} of session footage`,
  );
  await ffmpeg(
    [
      "-i",
      sourceVideo,
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[vout]",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ],
    "recut",
  );

  const cut = await probeVideo(videoPath);
  log.ok(
    `Recut to ${fmtDuration(cut.durationMs)} ` +
      dim(`(dropped ${fmtDuration(Math.max(0, source.durationMs - cut.durationMs))} of exploration)`),
  );

  return {
    videoPath,
    timeline: {
      slug,
      videoFile: path.basename(videoPath),
      width: cut.width || source.width,
      height: cut.height || source.height,
      leadInMs: introMs,
      tailMs: 0,
      totalMs: cut.durationMs,
      entries,
    },
  };
}
