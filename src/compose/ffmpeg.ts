import { execa } from "execa";
import { config } from "../config.js";

/** Thin wrapper so every ffmpeg failure reports the command and stderr tail. */
export async function ffmpeg(args: string[], label: string): Promise<void> {
  try {
    await execa(config.ffmpegBin, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  } catch (error) {
    const err = error as {
      stderr?: string;
      message: string;
      exitCode?: number;
      signal?: string;
    };
    // `??` let an empty stderr through as the message, which reported a bare
    // "ffmpeg failed during recut:" and hid the actual cause - in one case the
    // kernel OOM-killing the process, which says nothing on stderr at all.
    const detail = (err.stderr || err.message || "").trim().split("\n").slice(-6).join("\n  ");
    const killed =
      err.signal === "SIGKILL" || /killed/i.test(err.message ?? "")
        ? "\n  It was killed - almost certainly out of memory. " +
          "Check the container's memory limit."
        : "";
    throw new Error(
      `ffmpeg failed during ${label}` +
        (err.exitCode !== undefined ? ` (exit ${err.exitCode})` : "") +
        `:\n  ${detail || "(no output)"}${killed}`,
    );
  }
}

export async function ffprobe(args: string[]): Promise<string> {
  const { stdout } = await execa(config.ffprobeBin, args);
  return stdout.trim();
}

export async function probeDurationMs(file: string): Promise<number> {
  const seconds = await ffprobe([
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const value = Number(seconds);
  if (!Number.isFinite(value)) {
    throw new Error(`Could not read a duration from ${file}`);
  }
  return Math.round(value * 1000);
}

export interface VideoInfo {
  width: number;
  height: number;
  durationMs: number;
}

export async function probeVideo(file: string): Promise<VideoInfo> {
  const raw = await ffprobe([
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    file,
  ]);
  // Two lines: "WIDTH,HEIGHT" then "DURATION".
  const [dimensions, duration] = raw.split("\n");
  const [width, height] = (dimensions ?? "").split(",").map(Number);
  return {
    width: width ?? 0,
    height: height ?? 0,
    durationMs: Math.round(Number(duration ?? 0) * 1000),
  };
}

let filterCache: Set<string> | null = null;

/**
 * Which filters this ffmpeg build actually has.
 *
 * Homebrew's ffmpeg ships without libass, so `subtitles` - the burn-in filter -
 * is simply absent. Checking up front turns a cryptic "No such filter" deep in
 * an encode into an answerable message.
 */
export async function hasFilter(name: string): Promise<boolean> {
  if (!filterCache) {
    try {
      const { stdout } = await execa(config.ffmpegBin, ["-hide_banner", "-filters"]);
      filterCache = new Set(
        stdout
          .split("\n")
          .map((line) => line.trim().split(/\s+/)[1])
          .filter((x): x is string => Boolean(x)),
      );
    } catch {
      filterCache = new Set();
    }
  }
  return filterCache.has(name);
}

/** A silent mono track of exactly this length, used to pad between lines. */
export async function makeSilence(outFile: string, ms: number): Promise<void> {
  await ffmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=mono:sample_rate=44100",
      "-t",
      (ms / 1000).toFixed(3),
      "-c:a",
      "libmp3lame",
      "-q:a",
      "4",
      outFile,
    ],
    "silence generation",
  );
}
