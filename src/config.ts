import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";
import { projectRoot } from "./paths.js";

const envFile = path.join(projectRoot, ".env");
if (fs.existsSync(envFile)) dotenv.config({ path: envFile, quiet: true });

/**
 * Model choices. The scout and the distiller both do hard, long-horizon
 * reasoning, so they get Opus at high effort; everything else inherits it.
 * Overridable for cost experiments without touching call sites.
 */
export const MODEL = process.env.VDG_MODEL ?? "claude-opus-5";
export const EFFORT = (process.env.VDG_EFFORT ?? "high") as
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type TtsProviderName = "elevenlabs" | "openai" | "say";

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  tts: {
    provider: (process.env.VDG_TTS_PROVIDER ?? "elevenlabs") as TtsProviderName,
    elevenLabsKey: process.env.ELEVENLABS_API_KEY ?? "",
    // "Matilda" - warm and conversational, which suits a colleague walking you
    // through a product. Pinned by id so demos sound the same on any machine.
    elevenLabsVoice: process.env.ELEVENLABS_VOICE_ID ?? "XrExE9yKIg1WjnnlVkGX",
    /** Delivery rate. Above ~1.15 diction suffers on UI labels and names. */
    elevenLabsSpeed: Number(process.env.VDG_TTS_SPEED ?? 1.08),
    elevenLabsModel: process.env.ELEVENLABS_MODEL_ID ?? "eleven_turbo_v2_5",
    openAiKey: process.env.OPENAI_API_KEY ?? "",
    openAiModel: process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts",
    openAiVoice: process.env.OPENAI_TTS_VOICE ?? "alloy",
  },
  demo: {
    username: process.env.VDG_DEMO_USERNAME ?? "",
    password: process.env.VDG_DEMO_PASSWORD ?? "",
  },
  brand: {
    /** Logo shown on the opening card. Relative paths resolve from the repo root. */
    logoPath: process.env.VDG_BRAND_LOGO ?? "assets/factorial-logo.png",
    /** Line under the title; empty string hides it. */
    tagline: process.env.VDG_BRAND_TAGLINE ?? "",
  },
  video: {
    width: Number(process.env.VDG_VIDEO_WIDTH ?? 1920),
    height: Number(process.env.VDG_VIDEO_HEIGHT ?? 1080),
    /** Retina-ish capture; ffmpeg downscales to the target on compose. */
    deviceScaleFactor: Number(process.env.VDG_DEVICE_SCALE ?? 2),
  },
  narration: {
    /** Target speaking rate used to budget per-step script length. */
    wpm: Number(process.env.VDG_WPM ?? 150),
    /**
     * Language the voiceover is written in. Independent of the product's own
     * language: a Spanish-rendered demo tenant still gets English narration
     * unless this says otherwise, with UI labels quoted as they appear.
     */
    language: process.env.VDG_LANGUAGE ?? "English",
  },
  crawl: {
    maxPages: Number(process.env.VDG_MAX_PAGES ?? 400),
    concurrency: Number(process.env.VDG_CRAWL_CONCURRENCY ?? 6),
    userAgent:
      process.env.VDG_USER_AGENT ??
      "video-demo-generator/0.1 (+docs ingestion; respects robots.txt)",
  },
  ffmpegBin: process.env.VDG_FFMPEG ?? "ffmpeg",
  ffprobeBin: process.env.VDG_FFPROBE ?? "ffprobe",
} as const;

export function requireAnthropicKey(): string {
  if (!config.anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env (see .env.example), " +
        "then re-run. `vdg doctor` shows everything that is missing.",
    );
  }
  return config.anthropicApiKey;
}
