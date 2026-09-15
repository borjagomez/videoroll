import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { config } from "../config.js";
import { ffmpeg, hasFilter } from "./ffmpeg.js";
import { buildCues, toSrt, toVtt } from "../subs/srt.js";
import { outDir, demoDir, ensureDir, rel } from "../paths.js";
import type { DemoScript, Narration, Timeline } from "../types.js";
import { log, dim, fmtDuration } from "../log.js";

export interface ComposeOptions {
  script: DemoScript;
  narration: Narration;
  timeline: Timeline;
  videoPath: string;
  /** Also render a copy with the subtitles burned into the picture. */
  burnSubs?: boolean;
  /** Constant rate factor; lower is better quality and a bigger file. */
  crf?: number;
}

export interface ComposeResult {
  mp4: string;
  srt: string;
  vtt: string;
  thumbnail: string;
  burned?: string;
}

const SUBTITLE_STYLE = [
  "FontName=Helvetica",
  "FontSize=22",
  "PrimaryColour=&H00FFFFFF",
  "OutlineColour=&H90000000",
  "BorderStyle=3",
  "Outline=2",
  "Shadow=0",
  "MarginV=44",
  "Alignment=2",
].join("\\,");

/**
 * Lays each narration clip at the offset the recorder measured for its step.
 *
 * `adelay` per input plus a single `amix` places clips on an absolute timeline,
 * which is what keeps voice and picture together: the recorder held each step
 * for its clip's exact length, so putting the clip back at that step's start is
 * all the synchronisation there is to do.
 */
function audioFilter(
  narration: Narration,
  timeline: Timeline,
): { inputs: string[]; filter: string; label: string } | null {
  const offsets = new Map(timeline.entries.map((e) => [e.stepId, e.startMs]));
  const audible = narration.steps.filter((s) => s.audioFile && offsets.has(s.stepId));
  if (audible.length === 0) return null;

  const inputs: string[] = [];
  const parts: string[] = [];
  const labels: string[] = [];

  for (const [i, step] of audible.entries()) {
    const index = i + 1; // input 0 is the video
    const delay = Math.max(0, Math.round(offsets.get(step.stepId)!));
    inputs.push("-i", path.join(demoDir(narration.slug), step.audioFile!));
    parts.push(`[${index}:a]adelay=${delay}|${delay},aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`);
    labels.push(`[a${index}]`);
  }

  parts.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[aout]`);
  return { inputs, filter: parts.join(";"), label: "[aout]" };
}

/**
 * Drop the stretch of cover that existed only to hide the app booting.
 *
 * The cover has to span the app's start - ten seconds on a heavy product - but
 * it is a still image once its title has landed, so most of that is dead
 * weight. Keeping `[0, leadInMs]` preserves the entrance; resuming at
 * `leadInMs + trimStartMs` picks the footage up exactly where step 1 begins.
 */
function trimFilter(timeline: Timeline): { filter: string; label: string } | null {
  if (timeline.trimStartMs <= 0) return null;
  const keep = (timeline.leadInMs / 1000).toFixed(3);
  const resume = ((timeline.leadInMs + timeline.trimStartMs) / 1000).toFixed(3);
  return {
    filter:
      `[0:v]trim=start=0:end=${keep},setpts=PTS-STARTPTS[vhead];` +
      `[0:v]trim=start=${resume},setpts=PTS-STARTPTS[vbody];` +
      `[vhead][vbody]concat=n=2:v=1:a=0[vout]`,
    label: "[vout]",
  };
}

export async function compose(options: ComposeOptions): Promise<ComposeResult> {
  const { script, narration, timeline } = options;
  const dir = ensureDir(outDir(script.slug));

  // Subtitles first: the burn-in pass needs the file on disk.
  const offsets = new Map(timeline.entries.map((e) => [e.stepId, e.startMs]));
  const cues = buildCues(narration, offsets);
  const srt = path.join(dir, "demo.srt");
  const vtt = path.join(dir, "demo.vtt");
  fs.writeFileSync(srt, toSrt(cues), "utf8");
  fs.writeFileSync(vtt, toVtt(cues), "utf8");
  log.detail(dim(`  ${cues.length} subtitle cues`));

  const audio = audioFilter(narration, timeline);
  const mp4 = path.join(dir, "demo.mp4");

  // Input order matters for the -map indices below: video, then one input per
  // narration clip, then the subtitle file last.
  const args: string[] = ["-i", options.videoPath];
  if (audio) args.push(...audio.inputs);
  const subtitleInput = 1 + (audio ? audio.inputs.length / 2 : 0);
  args.push("-i", srt);
  // Excise the dead middle of the cover, keeping its opening - the title's
  // entrance lives there - and rejoining at the moment step 1 begins. Seeking
  // past it instead would drop the animation entirely.
  const video = trimFilter(timeline);
  const graph = [video?.filter, audio?.filter].filter(Boolean).join(";");
  if (graph) args.push("-filter_complex", graph);

  args.push(
    "-map",
    video ? video.label : "0:v:0",
    ...(audio ? ["-map", audio.label] : []),
    // A soft track every player can toggle. Burning in is a separate, optional
    // pass; this one always ships with the file.
    "-map",
    `${subtitleInput}:s:0`,
    "-c:s",
    "mov_text",
    "-metadata:s:s:0",
    "language=eng",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    String(options.crf ?? 18),
    "-pix_fmt",
    "yuv420p",
    // Keyframe every 2s so scrubbing in a player is responsive.
    "-g",
    "60",
    "-movflags",
    "+faststart",
  );
  if (audio) args.push("-c:a", "aac", "-b:a", "160k");
  args.push(mp4);

  log.step("Encoding the video");
  await ffmpeg(args, "muxing");

  const thumbnail = path.join(dir, "thumbnail.png");
  const thumbAtMs = timeline.entries.at(-1)?.startMs ?? Math.round(timeline.totalMs / 2);
  await ffmpeg(
    [
      "-ss",
      (thumbAtMs / 1000).toFixed(2),
      "-i",
      mp4,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      thumbnail,
    ],
    "thumbnail",
  );

  const result: ComposeResult = { mp4, srt, vtt, thumbnail };

  if (options.burnSubs) {
    if (!(await hasFilter("subtitles"))) {
      throw new Error(
        "This ffmpeg has no `subtitles` filter, so subtitles cannot be burned in.\n" +
          "  It needs a build with libass:\n" +
          "    brew uninstall ffmpeg && brew install ffmpeg --with-libass\n" +
          "  or use a full build such as `brew install homebrew-ffmpeg/ffmpeg/ffmpeg`.\n" +
          `  ${rel(mp4)} already carries a soft subtitle track that players can ` +
          "toggle, and demo.srt sits beside it.",
      );
    }
    log.step("Burning subtitles in");
    const burned = path.join(dir, "demo-subtitled.mp4");
    // Run from the output directory so the filter takes a bare filename and we
    // never have to escape ':' or spaces inside an ffmpeg filter string.
    try {
      await execa(
        config.ffmpegBin,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          "demo.mp4",
          "-vf",
          // Named options and escaped commas: ffmpeg 9's filtergraph parser
          // rejects the positional shorthand that older builds accepted.
          `subtitles=filename=demo.srt:force_style=${SUBTITLE_STYLE}`,
          "-c:v",
          "libx264",
          "-preset",
          "slow",
          "-crf",
          String(options.crf ?? 18),
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "copy",
          "demo-subtitled.mp4",
        ],
        { cwd: dir },
      );
      result.burned = burned;
    } catch (error) {
      const err = error as { stderr?: string; message: string };
      throw new Error(
        `Burning subtitles failed:\n  ` +
          (err.stderr ?? err.message).trim().split("\n").slice(-4).join("\n  "),
      );
    }
  }

  log.blank();
  log.ok(`${script.featureName} — ${fmtDuration(timeline.totalMs)}`);
  log.info(`video      ${rel(result.mp4)}`);
  if (result.burned) log.info(`subtitled  ${rel(result.burned)}`);
  log.info(`subtitles  ${rel(srt)}  ${rel(vtt)}  ${dim("(also embedded in the mp4)")}`);
  log.info(`thumbnail  ${rel(thumbnail)}`);

  return result;
}
