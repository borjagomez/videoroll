import path from "node:path";
import { z } from "zod";
import { structured } from "../llm/client.js";
import { config } from "../config.js";
import { audioDir, ensureDir } from "../paths.js";
import { getTtsProvider, estimateWordTimings, type TtsProvider } from "./tts/index.js";
import type { DemoScript, Narration, NarrationStep } from "../types.js";
import { log, dim, fmtDuration, fmtCount } from "../log.js";

const PolishedSchema = z.object({
  lines: z
    .array(
      z.object({
        stepId: z.number().int().positive(),
        text: z.string().describe("The exact words the voice will say for this step"),
      }),
    )
    .min(1),
});

const POLISH_INSTRUCTIONS = `You are writing the voiceover for a short product demo.

Each step below was recorded from the live product, with a rough narration line
written while it was performed. Rewrite those lines into one continuous script.

Rules:
- One line per step, keyed by stepId. Keep every stepId, in order.
- The first line orients the viewer: what they are looking at and what is about
  to happen. The last line lands the result.
- Write for the ear. Short sentences. Contractions. No bullet-point voice.
- Say what the action accomplishes, not what the mouse does. "Approving it
  releases the days back to her balance" beats "click the Approve button".
- Do not narrate the UI mechanics the viewer can already see, and never say
  "as you can see" or "simply".
- Vary sentence openings. Consecutive lines starting with "Now" or "Next" are
  the main thing that makes these sound machine-written.
- Target LENGTH_HINT words per line. A line may run shorter when the step is
  trivial, but never longer than double the target - the video holds on each
  step for exactly as long as its line takes to say, so a long line means a
  long, static shot.`;

function targetWordsPerLine(wpm: number): number {
  // ~4 seconds of speech per step reads as unhurried without dragging.
  return Math.round((wpm / 60) * 4);
}

async function polish(script: DemoScript, wpm: number): Promise<Map<number, string>> {
  const steps = script.steps
    .map(
      (s) =>
        `stepId ${s.id}: ${s.action}` +
        (s.caption ? ` — "${s.caption}"` : "") +
        `\n  rough line: ${s.narration}` +
        (s.note ? `\n  context: ${s.note}` : ""),
    )
    .join("\n");

  const result = await structured(
    "narration",
    {
      instructions: POLISH_INSTRUCTIONS.replace(
        "LENGTH_HINT",
        String(targetWordsPerLine(wpm)),
      ),
      user: `Demo: ${script.featureName}\nRequest: ${script.request}\n\nSteps:\n${steps}`,
    },
    PolishedSchema,
  );

  const byStep = new Map(result.lines.map((line) => [line.stepId, line.text.trim()]));
  // Never let a polish pass silently drop a step - fall back to the scout's line.
  for (const step of script.steps) {
    if (!byStep.get(step.id)) byStep.set(step.id, step.narration);
  }
  return byStep;
}

export interface NarrateOptions {
  script: DemoScript;
  /** Skip TTS: keep the written script and pace from words-per-minute. */
  silent?: boolean;
  wpm?: number;
  /** Reuse the scout's rough lines instead of paying for a polish pass. */
  skipPolish?: boolean;
}

export async function narrate(options: NarrateOptions): Promise<Narration> {
  const { script } = options;
  const wpm = options.wpm ?? config.narration.wpm;

  // The scout already wrote a usable line per step; the polish pass makes them
  // flow together. Without a key that pass is impossible, so fall back to the
  // scout's lines rather than failing a run that needs no other model call.
  let skipPolish = options.skipPolish ?? false;
  if (!skipPolish && !config.anthropicApiKey) {
    log.warn("No ANTHROPIC_API_KEY - using the scout's raw narration lines.");
    skipPolish = true;
  }

  const lines = skipPolish
    ? new Map(script.steps.map((s) => [s.id, s.narration]))
    : await polish(script, wpm);

  let provider: TtsProvider | null = null;
  if (!options.silent) {
    provider = await getTtsProvider();
    log.step(`Voicing ${fmtCount(script.steps.length, "line")} with ${provider.name}`);
  } else {
    log.step("Writing the script without audio (--no-voice)");
  }

  const dir = ensureDir(audioDir(script.slug));
  const steps: NarrationStep[] = [];

  for (const step of script.steps) {
    const text = lines.get(step.id) ?? step.narration;

    if (!provider) {
      // Pace from the target speaking rate so the video still breathes
      // correctly and subtitles stay in step with the captions.
      const words = text.split(/\s+/).filter(Boolean).length;
      const durationMs = Math.max(1600, Math.round((words / wpm) * 60_000));
      steps.push({
        stepId: step.id,
        text,
        durationMs,
        words: estimateWordTimings(text, durationMs),
        timingsExact: false,
      });
      continue;
    }

    const file = path.join(dir, `step-${String(step.id).padStart(2, "0")}.mp3`);
    const spoken = await provider.speak(text, file);
    log.detail(
      dim(`  step ${step.id}: ${fmtDuration(spoken.durationMs)} ${spoken.timingsExact ? "" : "(estimated timings)"}`),
    );

    steps.push({
      stepId: step.id,
      text,
      audioFile: path.relative(path.dirname(dir), spoken.audioFile),
      durationMs: spoken.durationMs,
      words: spoken.words,
      timingsExact: spoken.timingsExact,
    });
  }

  const totalMs = steps.reduce((sum, s) => sum + s.durationMs, 0);
  log.ok(`Narration ready — ${fmtDuration(totalMs)} of speech`);

  return {
    slug: script.slug,
    provider: provider?.name ?? "none",
    ...(provider?.voice ? { voice: provider.voice } : {}),
    wpm,
    totalMs,
    steps,
  };
}
