import fs from "node:fs";
import path from "node:path";
import { ffmpeg, probeVideo } from "./ffmpeg.js";
import { ensureDir, rawVideoDir } from "../paths.js";
import type { StepSegment } from "../scout/tools.js";
import type { Narration, Timeline } from "../types.js";
import { log, dim, fmtDuration } from "../log.js";

/** Gap left between shots, matching the deterministic recorder's pacing. */
const SEGMENT_PADDING_MS = Number(process.env.VDG_STEP_PADDING_MS ?? 550);
/** How much of the opening cover to keep, taken from the head of the recording. */
const INTRO_MS = Number(process.env.VDG_TITLE_MS ?? 4_200);
/**
 * Fast-seek this far before each cut, then seek accurately within it.
 *
 * Seeking before `-i` is instant but lands on a keyframe; seeking after `-i` is
 * frame-accurate but decodes from the start of the file. Doing both bounds the
 * decoding to about this much video per shot while keeping the cut exact.
 */
const SEEK_LEAD_MS = 3_000;

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

export interface Shot {
  /** null for the opening cover, which belongs to no step. */
  stepId: number | null;
  startMs: number;
  useMs: number;
  padMs: number;
  targetMs: number;
}

/**
 * Work out what each shot contains before any encoding happens.
 *
 * Every shot lasts exactly as long as its narration line, taken from the start
 * of the window where the action happens. A recorded window can run far longer
 * - it ends once the model has finished looking at the result - so without the
 * cap a four-second line sat over twenty seconds of a still screen. When the
 * window is shorter than the line instead, the difference becomes `padMs` and
 * the last frame is held rather than rushing the voice.
 */
export function planShots(
  segments: StepSegment[],
  durationByStep: Map<number, number>,
  introMs: number,
): Shot[] {
  const shots: Shot[] = [];
  if (introMs > 0) {
    shots.push({ stepId: null, startMs: 0, useMs: introMs, padMs: 0, targetMs: introMs });
  }

  for (const segment of segments) {
    const availableMs = Math.max(600, segment.endMs - segment.startMs);
    const spokenMs = durationByStep.get(segment.stepId) ?? 2_000;
    const targetMs = spokenMs + SEGMENT_PADDING_MS;
    const useMs = Math.min(availableMs, targetMs);
    shots.push({
      stepId: segment.stepId,
      startMs: segment.startMs,
      useMs,
      padMs: targetMs - useMs,
      targetMs,
    });
  }
  return shots;
}

/**
 * The ffmpeg call that extracts one shot.
 *
 * The window is taken in the filter chain rather than with a second -ss and -t
 * after the input. Those are output options: -t would cap the output at the
 * length of the real footage and throw away the very frames tpad clones to
 * fill the rest of the line. That shipped once - shots came out at their
 * unpadded length, the video ran six seconds shorter than its own narration,
 * and every caption after the first padded shot slid out of sync.
 */
export function shotArgs(shot: Shot, sourceVideo: string, part: string): string[] {
  const lead = Math.min(SEEK_LEAD_MS, shot.startMs);
  const chain = [
    `trim=start=${secs(lead)}:duration=${secs(shot.useMs)}`,
    "setpts=PTS-STARTPTS",
    ...(shot.padMs > 0 ? [`tpad=stop_mode=clone:stop_duration=${secs(shot.padMs)}`] : []),
  ].join(",");

  return [
    "-ss",
    secs(shot.startMs - lead),
    "-i",
    sourceVideo,
    "-vf",
    chain,
    // A guard, not the cut: the chain above already decides the length.
    "-t",
    secs(shot.targetMs),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    // Identical settings for every part, so they join without re-encoding.
    "-g",
    "60",
    part,
  ];
}

/**
 * Cut a one-pass recording down to the demo.
 *
 * The camera runs for the whole scouting session, so the raw file holds every
 * wrong turn on the way to the working path. Only the windows marked as
 * recorded steps belong in the video, and each has to last as long as its
 * narration line - actions are usually quicker than the sentence describing
 * them, so the last frame is held to fill the difference rather than rushing
 * the voice.
 *
 * Each shot is extracted in its own pass and the results are concatenated.
 * Doing it as one filter graph - N `trim` branches off a single input - is the
 * obvious approach and it does not scale: a branch starting at 80 seconds needs
 * frames decoded from the beginning while another consumes the first four, so
 * ffmpeg buffers everything in between. On a two-minute 1080p source that is
 * roughly 11 GB of raw frames, which survives on a workstation and is
 * OOM-killed in a container. Separate passes stream, so memory stays flat
 * however long the session ran.
 */
export async function recut(options: RecutOptions): Promise<RecutResult> {
  const { slug, sourceVideo, segments, narration } = options;
  if (segments.length === 0) {
    throw new Error("Nothing to cut: the scout marked no steps as recorded.");
  }

  const durationByStep = new Map(narration.steps.map((s) => [s.stepId, s.durationMs]));
  const source = await probeVideo(sourceVideo);
  const introMs = Math.min(options.introMs ?? INTRO_MS, INTRO_MS, source.durationMs);

  const shots = planShots(segments, durationByStep, introMs);

  const outDirectory = ensureDir(rawVideoDir(slug));
  const partsDir = ensureDir(path.join(outDirectory, "parts"));
  for (const stale of fs.readdirSync(partsDir)) {
    fs.rmSync(path.join(partsDir, stale), { force: true });
  }

  log.step(
    `Cutting ${segments.length} shots out of ${fmtDuration(source.durationMs)} of session footage`,
  );

  const parts: string[] = [];
  for (const [index, shot] of shots.entries()) {
    const part = path.join(partsDir, `part-${String(index).padStart(2, "0")}.mp4`);
    await ffmpeg(shotArgs(shot, sourceVideo, part), `shot ${index + 1} of ${shots.length}`);
    parts.push(part);
  }

  const listFile = path.join(partsDir, "parts.txt");
  fs.writeFileSync(
    listFile,
    parts.map((p) => `file '${path.basename(p)}'`).join("\n") + "\n",
    "utf8",
  );

  const videoPath = path.join(outDirectory, "recut.mp4");
  await ffmpeg(
    ["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", videoPath],
    "joining shots",
  );

  const cut = await probeVideo(videoPath);

  // Offsets come from the shot plan rather than the encoded file, so the
  // narration lines up even if a container rounds a duration.
  const entries: Timeline["entries"] = [];
  let offsetMs = 0;
  for (const shot of shots) {
    if (shot.stepId !== null) {
      entries.push({ stepId: shot.stepId, startMs: offsetMs, endMs: offsetMs + shot.targetMs });
    }
    offsetMs += shot.targetMs;
  }

  log.ok(
    `Recut to ${fmtDuration(cut.durationMs)} ` +
      dim(
        `(dropped ${fmtDuration(Math.max(0, source.durationMs - cut.durationMs))} of exploration)`,
      ),
  );

  return {
    videoPath,
    timeline: {
      slug,
      videoFile: path.basename(videoPath),
      width: cut.width || source.width,
      height: cut.height || source.height,
      leadInMs: introMs,
      // The cut already dropped the surplus; nothing more to trim at encode.
      trimStartMs: 0,
      tailMs: 0,
      totalMs: cut.durationMs,
      entries,
    },
  };
}
