import { describe, it, expect } from "vitest";
import { planShots, shotArgs, type Shot } from "./recut.js";

/** Narration durations keyed by step, as `recut` builds them. */
const spoken = new Map([
  [1, 5_616],
  [2, 3_788],
]);

describe("shot planning", () => {
  it("gives every shot the length of its line, padding a short window", () => {
    const shots = planShots(
      [
        // A window far shorter than the line: the rest must be held.
        { stepId: 1, startMs: 79_977, endMs: 83_764 },
        // A window longer than the line: the surplus must be dropped.
        { stepId: 2, startMs: 95_199, endMs: 110_000 },
      ],
      spoken,
      4_200,
    );

    expect(shots[0]).toMatchObject({ stepId: null, targetMs: 4_200, padMs: 0 });
    expect(shots[1]).toMatchObject({ useMs: 3_787, padMs: 2_379, targetMs: 6_166 });
    expect(shots[2]).toMatchObject({ useMs: 4_338, padMs: 0, targetMs: 4_338 });
  });
});

describe("shot extraction", () => {
  const padded: Shot = {
    stepId: 1,
    startMs: 79_977,
    useMs: 3_787,
    padMs: 2_379,
    targetMs: 6_166,
  };

  /** Read the value ffmpeg would take for a flag. */
  const valueOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it("lets the held frames survive, rather than capping the output at the footage", () => {
    const args = shotArgs(padded, "session.webm", "part-01.mp4");

    // The regression: -t is an output option, so capping it at useMs discards
    // exactly the frames tpad clones, and the shot comes out short.
    expect(valueOf(args, "-t")).toBe("6.166");
    expect(valueOf(args, "-vf")).toContain("duration=3.787");
    expect(valueOf(args, "-vf")).toContain("stop_duration=2.379");
  });

  it("seeks fast to just before the cut, then trims to the frame", () => {
    const args = shotArgs(padded, "session.webm", "part-01.mp4");

    // Input seek lands 3s early on a keyframe; the chain takes it from there,
    // so the cut is exact without decoding 80s of video to reach it.
    expect(valueOf(args, "-ss")).toBe("76.977");
    expect(valueOf(args, "-vf")).toContain("trim=start=3.000");
  });

  it("does not pad a shot that already fills its line", () => {
    const args = shotArgs(
      { stepId: 2, startMs: 1_000, useMs: 4_338, padMs: 0, targetMs: 4_338 },
      "session.webm",
      "part-02.mp4",
    );
    expect(valueOf(args, "-vf")).not.toContain("tpad");
  });

  it("does not seek behind the start of the file", () => {
    const args = shotArgs(
      { stepId: null, startMs: 0, useMs: 4_200, padMs: 0, targetMs: 4_200 },
      "session.webm",
      "part-00.mp4",
    );
    expect(valueOf(args, "-ss")).toBe("0.000");
    expect(valueOf(args, "-vf")).toContain("trim=start=0.000");
  });
});
