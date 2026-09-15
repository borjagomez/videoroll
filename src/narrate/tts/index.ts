import { config, type TtsProviderName } from "../../config.js";
import type { WordTiming } from "../../types.js";

export interface SpokenLine {
  /** Absolute path to the rendered audio. */
  audioFile: string;
  durationMs: number;
  /** Relative to the start of this clip. */
  words: WordTiming[];
  /** False when the provider gave no timings and these were estimated. */
  timingsExact: boolean;
}

export interface TtsProvider {
  readonly name: TtsProviderName;
  readonly voice?: string;
  speak(text: string, outFile: string): Promise<SpokenLine>;
}

/**
 * Spread a known total duration across words in proportion to their length.
 *
 * Used for providers that return no timings. It is visibly worse than real
 * alignment on long lines - which is why ElevenLabs is the default - but it
 * keeps subtitles readable instead of dumping one caption per step.
 */
export function estimateWordTimings(text: string, durationMs: number): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  // +1 per word approximates the pause that follows it.
  const weights = words.map((w) => w.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);

  let cursor = 0;
  return words.map((word, i) => {
    const share = (weights[i]! / total) * durationMs;
    const startMs = cursor;
    cursor += share;
    return { word, startMs: Math.round(startMs), endMs: Math.round(cursor) };
  });
}

/**
 * Character-level timings (ElevenLabs) collapsed into words. Whitespace
 * characters delimit; a word spans from its first character's start to its
 * last character's end.
 */
export function wordsFromCharacterTimings(
  characters: string[],
  startSeconds: number[],
  endSeconds: number[],
): WordTiming[] {
  const words: WordTiming[] = [];
  let current = "";
  let startMs = 0;
  let endMs = 0;

  for (let i = 0; i < characters.length; i++) {
    const char = characters[i] ?? "";
    const charStart = Math.round((startSeconds[i] ?? 0) * 1000);
    const charEnd = Math.round((endSeconds[i] ?? 0) * 1000);

    if (/\s/.test(char)) {
      if (current) {
        words.push({ word: current, startMs, endMs });
        current = "";
      }
      continue;
    }
    if (!current) startMs = charStart;
    current += char;
    endMs = charEnd;
  }
  if (current) words.push({ word: current, startMs, endMs });
  return words;
}

export async function getTtsProvider(
  name: TtsProviderName = config.tts.provider,
): Promise<TtsProvider> {
  switch (name) {
    case "elevenlabs": {
      const { ElevenLabsProvider } = await import("./elevenlabs.js");
      return new ElevenLabsProvider();
    }
    case "openai": {
      const { OpenAiProvider } = await import("./openai.js");
      return new OpenAiProvider();
    }
    case "say": {
      const { SayProvider } = await import("./say.js");
      return new SayProvider();
    }
    default:
      throw new Error(
        `Unknown TTS provider "${name}". Use elevenlabs, openai or say.`,
      );
  }
}
