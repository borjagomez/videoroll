import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobQueue } from "./jobs.js";
import { withJob, log } from "../log.js";
import type { DemoResult, RunDemoOptions } from "../pipeline.js";

let workspace: string;

/** A workspace holding one fully-rendered demo, as the library expects. */
function seedDemo(slug: string, featureName: string) {
  const dir = path.join(workspace, "demos", slug);
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "out", "demo.mp4"), "video-bytes");
  fs.writeFileSync(path.join(dir, "out", "demo.srt"), "1\n");
  fs.writeFileSync(path.join(dir, "out", "thumbnail.png"), "png");
  fs.writeFileSync(
    path.join(dir, "steps.json"),
    JSON.stringify({
      slug,
      request: featureName,
      featureName,
      product: "p",
      profile: "demo",
      startUrl: "https://example.test/start",
      createdAt: new Date().toISOString(),
      divergences: [],
      steps: [
        {
          id: 1,
          action: "click",
          locator: { kind: "role", role: "button", name: "Go" },
          narration: "We begin.",
          caption: "Begin",
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dir, "timeline.json"),
    JSON.stringify({
      slug,
      videoFile: "raw.webm",
      width: 1920,
      height: 1080,
      leadInMs: 4200,
      trimStartMs: 0,
      tailMs: 1200,
      totalMs: 40355,
      entries: [{ stepId: 1, startMs: 4200, endMs: 9000 }],
    }),
  );
}

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "vdg-server-test-"));
  process.env.VDG_WORKSPACE = workspace;
  seedDemo("approve-a-request", "Approve a request");
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  delete process.env.VDG_WORKSPACE;
});

describe("library", () => {
  it("lists demos that have actually been rendered", async () => {
    const { listDemos } = await import("./library.js");
    const demos = listDemos();
    expect(demos).toHaveLength(1);
    expect(demos[0]!.slug).toBe("approve-a-request");
    expect(demos[0]!.video).toBe("/videos/approve-a-request/demo.mp4");
    expect(demos[0]!.durationMs).toBe(40355);
  });

  it("ignores a directory with no rendered video", async () => {
    fs.mkdirSync(path.join(workspace, "demos", "half-finished", "out"), {
      recursive: true,
    });
    const { listDemos, getDemo } = await import("./library.js");
    expect(getDemo("half-finished")).toBeNull();
    expect(listDemos().map((d) => d.slug)).not.toContain("half-finished");
  });

  it("serves only the demo's own output files", async () => {
    const { resolveAsset } = await import("./library.js");
    expect(resolveAsset("approve-a-request", "demo.mp4")).toBeTruthy();
    // Artifacts that are not part of the published demo stay private.
    expect(resolveAsset("approve-a-request", "steps.json")).toBeNull();
  });

  it("refuses a slug that climbs out of the workspace", async () => {
    const { resolveAsset } = await import("./library.js");
    // These arrive over HTTP, so a traversal must not reach the filesystem.
    expect(resolveAsset("../../../etc", "demo.mp4")).toBeNull();
    expect(resolveAsset("..", "demo.mp4")).toBeNull();
  });
});

describe("job queue", () => {
  let order: string[];
  let queue: JobQueue;

  beforeEach(() => {
    order = [];
  });

  /** A stand-in for the pipeline that records when it ran. */
  const fakeRun =
    (ms: number) =>
    async (options: RunDemoOptions): Promise<DemoResult> => {
      order.push(`start:${options.request}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end:${options.request}`);
      return {
        slug: "approve-a-request",
        featureName: "Approve a request",
        videoPath: "",
        srtPath: "",
        vttPath: "",
        thumbnailPath: "",
        durationMs: 1000,
        stepCount: 1,
        divergences: [],
        reused: false,
      };
    };

  it("runs one demo at a time, never overlapping", async () => {
    queue = new JobQueue(fakeRun(120));
    const a = queue.enqueue({ request: "a", product: "p", profile: "demo" });
    const b = queue.enqueue({ request: "b", product: "p", profile: "demo" });

    await new Promise((r) => setTimeout(r, 900));

    // Overlap would interleave these; one tenant means strict succession.
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
    expect(queue.get(a.id)?.state).toBe("done");
    expect(queue.get(b.id)?.state).toBe("done");
  });

  it("reports where a job sits in line", async () => {
    queue = new JobQueue(fakeRun(200));
    const a = queue.enqueue({ request: "a", product: "p", profile: "demo" });
    const b = queue.enqueue({ request: "b", product: "p", profile: "demo" });

    await new Promise((r) => setTimeout(r, 60));
    expect(queue.positionOf(a.id)).toBe(0); // running
    expect(queue.positionOf(b.id)).toBeGreaterThan(0); // waiting
    await new Promise((r) => setTimeout(r, 600));
  });

  it("records a failure instead of throwing", async () => {
    queue = new JobQueue(async () => {
      throw new Error("scout could not find the button");
    });
    const job = queue.enqueue({ request: "x", product: "p", profile: "demo" });
    await new Promise((r) => setTimeout(r, 400));

    const finished = queue.get(job.id)!;
    expect(finished.state).toBe("failed");
    expect(finished.error).toContain("could not find the button");
  });

  it("captures pipeline progress against the running job", async () => {
    queue = new JobQueue(async () => {
      // The pipeline narrates itself through `log`; that is what gets captured.
      log.step("Scouting the live product");
      log.ok("Recorded 8 steps");
      return {
        slug: "approve-a-request",
        featureName: "Approve a request",
        videoPath: "",
        srtPath: "",
        vttPath: "",
        thumbnailPath: "",
        durationMs: 1,
        stepCount: 8,
        divergences: [],
        reused: false,
      };
    });

    const job = queue.enqueue({ request: "y", product: "p", profile: "demo" });
    await new Promise((r) => setTimeout(r, 400));

    const messages = queue.get(job.id)!.events.map((e) => e.message);
    expect(messages).toContain("Scouting the live product");
    expect(messages).toContain("Recorded 8 steps");
  });
});

describe("job context", () => {
  it("strips terminal colour from streamed messages", async () => {
    const { progress } = await import("../log.js");
    const seen: string[] = [];
    const listener = (e: { message: string }) => seen.push(e.message);
    progress.on("progress", listener);

    await withJob("job_x", async () => {
      log.detail("[2mdimmed text[0m");
    });
    progress.off("progress", listener);

    // A chat front end should receive words, not escape codes.
    expect(seen.some((m) => m === "dimmed text")).toBe(true);
    expect(seen.every((m) => !m.includes(""))).toBe(true);
  });
});
