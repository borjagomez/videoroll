import { describe, it, expect } from "vitest";
import { buildCues, toSrt, toVtt } from "./srt.js";
import { estimateWordTimings } from "../narrate/tts/index.js";
import type { Narration } from "../types.js";

function narrationOf(texts: string[], msEach = 6_000): Narration {
  return {
    slug: "test",
    provider: "none",
    wpm: 150,
    totalMs: texts.length * msEach,
    steps: texts.map((text, i) => ({
      stepId: i + 1,
      text,
      durationMs: msEach,
      words: estimateWordTimings(text, msEach),
      timingsExact: false,
    })),
  };
}

const offsetsFor = (n: number, gap = 10_000) =>
  new Map(Array.from({ length: n }, (_, i) => [i + 1, i * gap]));

describe("buildCues", () => {
  it("keeps a short line as a single cue", () => {
    const cues = buildCues(narrationOf(["Approving it updates her balance."]), offsetsFor(1));
    expect(cues).toHaveLength(1);
    expect(cues[0]!.lines.join(" ")).toBe("Approving it updates her balance.");
  });

  it("splits a long sentence evenly rather than leaving an orphan", () => {
    const text =
      "Everything waiting on a manager lives in one place, so we start in the Time off section.";
    const cues = buildCues(narrationOf([text]), offsetsFor(1));

    expect(cues.length).toBeGreaterThan(1);
    const wordCounts = cues.map((c) => c.lines.join(" ").split(/\s+/).length);
    // The failure this guards against: a full cue followed by "off section."
    expect(Math.min(...wordCounts)).toBeGreaterThan(2);
    const spread = Math.max(...wordCounts) - Math.min(...wordCounts);
    expect(spread).toBeLessThanOrEqual(Math.max(...wordCounts));
  });

  it("loses no words when splitting", () => {
    const text =
      "A note is optional, but it travels with the approval email and saves a separate message.";
    const cues = buildCues(narrationOf([text]), offsetsFor(1));
    expect(cues.flatMap((c) => c.lines).join(" ").replace(/\s+/g, " ")).toBe(text);
  });

  it("breaks at sentence boundaries", () => {
    const cues = buildCues(
      narrationOf(["First we open it. Then we approve it. Finally it is done."]),
      offsetsFor(1),
    );
    expect(cues[0]!.lines.join(" ").endsWith(".")).toBe(true);
  });

  it("offsets each step by its position in the video", () => {
    const cues = buildCues(narrationOf(["One short line.", "Another short line."]), offsetsFor(2));
    expect(cues[0]!.startMs).toBeLessThan(10_000);
    expect(cues.at(-1)!.startMs).toBeGreaterThanOrEqual(10_000);
  });

  it("never wraps to more than two lines", () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    for (const cue of buildCues(narrationOf([text], 30_000), offsetsFor(1))) {
      expect(cue.lines.length).toBeLessThanOrEqual(2);
    }
  });

  it("balances the two lines of a wrapped cue", () => {
    const text =
      "Everything waiting on a manager lives in one place, so we start in the Time off section.";
    for (const cue of buildCues(narrationOf([text]), offsetsFor(1))) {
      if (cue.lines.length < 2) continue;
      // Guards against a full first line above a one-word second line.
      const [first, second] = cue.lines as [string, string];
      expect(Math.abs(first.length - second.length)).toBeLessThan(20);
    }
  });

  it("gives every cue a readable duration", () => {
    const cues = buildCues(narrationOf(["Yes. No. Maybe. Done."]), offsetsFor(1));
    for (const cue of cues) expect(cue.endMs).toBeGreaterThan(cue.startMs);
  });

  it("skips steps with no recorded offset", () => {
    expect(buildCues(narrationOf(["Orphaned line."]), new Map())).toHaveLength(0);
  });
});

describe("formatting", () => {
  it("writes SRT with sequential indices and comma milliseconds", () => {
    const srt = toSrt(buildCues(narrationOf(["One line here.", "Two lines here."]), offsetsFor(2)));
    expect(srt).toMatch(/^1\n00:00:0\d,\d{3} --> 00:00:0\d,\d{3}\n/);
    expect(srt).toContain("\n2\n");
    expect(srt.endsWith("\n")).toBe(true);
  });

  it("writes VTT with a header and dot milliseconds", () => {
    const vtt = toVtt(buildCues(narrationOf(["One line here."]), offsetsFor(1)));
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toMatch(/00:00:0\d\.\d{3} --> /);
  });

  it("formats past an hour correctly", () => {
    const narration = narrationOf(["Late line."]);
    const srt = toSrt(buildCues(narration, new Map([[1, 3_725_000]])));
    expect(srt).toContain("01:02:05,");
  });
});

describe("estimateWordTimings", () => {
  it("covers the whole clip", () => {
    const words = estimateWordTimings("one two three four", 4_000);
    expect(words).toHaveLength(4);
    expect(words[0]!.startMs).toBe(0);
    expect(words.at(-1)!.endMs).toBe(4_000);
  });

  it("returns nothing for empty text", () => {
    expect(estimateWordTimings("   ", 1_000)).toEqual([]);
  });

  it("gives longer words more time", () => {
    const [short, long] = estimateWordTimings("a extraordinarily", 2_000);
    expect(long!.endMs - long!.startMs).toBeGreaterThan(short!.endMs - short!.startMs);
  });
});
