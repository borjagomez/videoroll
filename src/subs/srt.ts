import type { Narration, WordTiming } from "../types.js";

export interface Cue {
  startMs: number;
  endMs: number;
  /** One or two lines, already wrapped. */
  lines: string[];
}

/** Broadcast-ish subtitle conventions: two lines, ~42 characters each. */
const MAX_CHARS_PER_LINE = 42;
const MAX_LINES = 2;
const MAX_CUE_MS = 6_000;
const MIN_CUE_MS = 1_200;
const GAP_MS = 80;

const endsSentence = (word: string) => /[.!?:]["')\]]?$/.test(word);

/**
 * Wrap a cue into at most two balanced lines.
 *
 * Greedy wrapping fills the first line and leaves whatever is left, which on a
 * 44-character cue means a full line above a single word. Choosing the break
 * that makes the two lines most equal reads far better and costs one pass.
 */
function wrap(text: string): string[] {
  if (text.length <= MAX_CHARS_PER_LINE) return [text];

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2) return [text];

  let best: { lines: string[]; imbalance: number } | null = null;
  for (let i = 1; i < words.length; i++) {
    const first = words.slice(0, i).join(" ");
    const second = words.slice(i).join(" ");
    if (first.length > MAX_CHARS_PER_LINE || second.length > MAX_CHARS_PER_LINE) continue;
    const imbalance = Math.abs(first.length - second.length);
    if (!best || imbalance < best.imbalance) best = { lines: [first, second], imbalance };
  }
  if (best) return best.lines;

  // Too long for two lines - splitSentence should have prevented this, but fall
  // back to greedy filling rather than dropping words.
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > MAX_CHARS_PER_LINE && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  if (lines.length <= MAX_LINES) return lines;
  return [...lines.slice(0, MAX_LINES - 1), lines.slice(MAX_LINES - 1).join(" ")];
}

const joinLength = (words: WordTiming[]) =>
  words.reduce((sum, w) => sum + w.word.length, 0) + Math.max(0, words.length - 1);

/**
 * Break one sentence into as few cues as it needs, sized evenly.
 *
 * Filling each cue to the brim and letting the remainder spill leaves orphans -
 * a five-second cue followed by "off section." for one second. Deciding the
 * cue count up front and aiming for equal shares instead keeps every cue
 * readable and roughly the same weight.
 */
function splitSentence(words: WordTiming[]): WordTiming[][] {
  if (words.length === 0) return [];

  const maxChars = MAX_CHARS_PER_LINE * MAX_LINES;
  const chars = joinLength(words);
  const span = words.at(-1)!.endMs - words[0]!.startMs;
  const parts = Math.max(1, Math.ceil(chars / maxChars), Math.ceil(span / MAX_CUE_MS));
  if (parts === 1) return [words];

  const target = chars / parts;
  const chunks: WordTiming[][] = [];
  let current: WordTiming[] = [];

  for (const word of words) {
    const wouldBe = joinLength([...current, word]);
    // Leave enough words for the remaining chunks, so none comes out empty.
    const roomLeft = words.length - (chunks.length + 1);
    if (
      current.length > 0 &&
      wouldBe > target &&
      chunks.length < parts - 1 &&
      roomLeft > 0
    ) {
      chunks.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Split one spoken line into cues.
 *
 * Breaks at sentence ends first, then sizes each sentence evenly. Timings come
 * from the words themselves, so with a provider that returns real alignment the
 * cue changes exactly when the speaker reaches that word.
 */
function cuesForLine(words: WordTiming[], offsetMs: number): Cue[] {
  if (words.length === 0) return [];

  const sentences: WordTiming[][] = [];
  let sentence: WordTiming[] = [];
  for (const word of words) {
    sentence.push(word);
    if (endsSentence(word.word)) {
      sentences.push(sentence);
      sentence = [];
    }
  }
  if (sentence.length > 0) sentences.push(sentence);

  const cues: Cue[] = [];
  for (const group of sentences) {
    for (const chunk of splitSentence(group)) {
      cues.push({
        startMs: offsetMs + chunk[0]!.startMs,
        endMs: offsetMs + chunk.at(-1)!.endMs,
        lines: wrap(chunk.map((w) => w.word).join(" ")),
      });
    }
  }

  // A cue that flashes past is unreadable; stretch it into the following gap.
  for (const [i, cue] of cues.entries()) {
    if (cue.endMs - cue.startMs >= MIN_CUE_MS) continue;
    const next = cues[i + 1];
    const ceiling = next ? next.startMs - GAP_MS : cue.startMs + MIN_CUE_MS;
    cue.endMs = Math.max(cue.endMs, Math.min(cue.startMs + MIN_CUE_MS, ceiling));
  }
  return cues;
}

/**
 * @param offsets absolute start of each step in the finished video, by stepId.
 */
export function buildCues(narration: Narration, offsets: Map<number, number>): Cue[] {
  const cues: Cue[] = [];
  for (const step of narration.steps) {
    const offset = offsets.get(step.stepId);
    if (offset === undefined) continue;
    cues.push(...cuesForLine(step.words, offset));
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

function stamp(ms: number, msSeparator: string): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${msSeparator}${pad(millis, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return (
    cues
      .map((cue, i) =>
        [
          String(i + 1),
          `${stamp(cue.startMs, ",")} --> ${stamp(cue.endMs, ",")}`,
          ...cue.lines,
        ].join("\n"),
      )
      .join("\n\n") + "\n"
  );
}

export function toVtt(cues: Cue[]): string {
  return (
    "WEBVTT\n\n" +
    cues
      .map((cue) =>
        [`${stamp(cue.startMs, ".")} --> ${stamp(cue.endMs, ".")}`, ...cue.lines].join("\n"),
      )
      .join("\n\n") +
    "\n"
  );
}
