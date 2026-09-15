import fs from "node:fs";
import path from "node:path";
import { getClient, buildSystem, reportUsage } from "../llm/client.js";
import { MODEL, EFFORT, config } from "../config.js";
import { launch, newContext, waitForContent } from "../browser.js";
import { storageStatePath, rawVideoDir, ensureDir } from "../paths.js";
import { nowIso } from "../io.js";
import { installCursor, placeCursor } from "../record/cursor.js";
import { installTitleCard, hideTitleCard } from "../record/titlecard.js";
import { ScoutSession, type StepSegment } from "./tools.js";
import { SCOUT_INSTRUCTIONS, renderStoryboard, renderAppMap } from "./scout.js";
import type { AppMap, DemoScript, Storyboard } from "../types.js";
import { log, dim, fmtCount } from "../log.js";

/** Extra guidance that only applies when the take is live. */
const onePassAddendum = (budget: number) => `
This session is being filmed. There is no second take and no replay: the
recording you are making now is the finished video.

- Everything you do is captured, but only the steps you record with
  record:true are kept - the rest is cut out afterwards.
- You have about ${budget} turns for the whole session, and exploring and
  recording come out of the same budget. Look around by all means, but be
  recording by roughly turn ${Math.floor(budget / 2)}. A session that maps the
  feature perfectly and runs out before recording anything produces no video
  at all, which is the one outcome worth avoiding.
- If you are unsure whether you have seen enough, record. A short demo of the
  part you understand beats nothing.
- Once you start recording steps, perform them in order and without detours.
  A recorded step is a shot in the final video.
- Do not record an action you then undo. There is no way to remove it later.`;

const INTRO_MS = Number(process.env.VDG_TITLE_MS ?? 4_200);
/**
 * Turns a filmed session may take.
 *
 * Exploring and recording share this, and a configuration screen - policy
 * editors especially - can spend fifty turns just reading what is there. Too
 * low and the session ends with a perfect map of the feature and no video.
 */
const ONE_PASS_BUDGET = Number(process.env.VDG_SCOUT_TURNS ?? 90);

export interface OneShotOptions {
  storyboard: Storyboard;
  appMap: AppMap;
  profile: string;
  headed?: boolean;
  maxIterations?: number;
}

export interface OneShotResult {
  script: DemoScript;
  segments: StepSegment[];
  videoPath: string;
  introMs: number;
}

/**
 * Scout and film in a single execution.
 *
 * The three-pass pipeline - scout, verify, then film - runs the demo three
 * times, and any feature that consumes something cannot survive that: dates get
 * booked, queue positions shift, policies gain versions. Here the camera simply
 * runs while the scout works, and `recut` keeps only the windows it marked.
 *
 * The trade is explicit. There is no independent proof the script replays,
 * because for these features that proof is unobtainable. What you get instead
 * is footage of the feature actually working.
 */
export async function scoutOneShot(options: OneShotOptions): Promise<OneShotResult> {
  const { storyboard, appMap, profile } = options;

  const videoDir = ensureDir(rawVideoDir(storyboard.slug));
  for (const stale of fs.readdirSync(videoDir)) {
    fs.rmSync(path.join(videoDir, stale), { force: true });
  }

  const size = { width: config.video.width, height: config.video.height };
  const browser = await launch(!options.headed);

  try {
    const context = await newContext(browser, {
      storageStatePath: storageStatePath(profile),
      viewport: size,
      deviceScaleFactor: config.video.deviceScaleFactor,
      recordVideo: { dir: videoDir, size },
    });
    await installCursor(context);
    await installTitleCard(context, { title: storyboard.featureName });

    const videoOrigin = Date.now();
    const page = await context.newPage();
    await page.goto(storyboard.startUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await waitForContent(page);

    // The card covers the app's boot; the head of the recording becomes the
    // finished video's intro, so hold it for at least the configured minimum.
    const heldFor = Date.now() - videoOrigin;
    if (heldFor < INTRO_MS) await page.waitForTimeout(INTRO_MS - heldFor);
    const introMs = Date.now() - videoOrigin;
    await hideTitleCard(page);
    await placeCursor(page, { x: 140, y: 140 });

    const session = new ScoutSession(page, storyboard.startUrl, {
      cinematic: true,
      videoOrigin,
    });

    const budget = options.maxIterations ?? ONE_PASS_BUDGET;

    log.step("Scouting with the camera running");
    const runner = getClient().beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 16000,
      system: buildSystem({
        cachedPrefix: [renderStoryboard(storyboard), renderAppMap(appMap)].join("\n\n"),
        instructions: SCOUT_INSTRUCTIONS + onePassAddendum(budget),
        user: "",
      }),
      output_config: { effort: EFFORT },
      tools: session.tools(),
      messages: [
        {
          role: "user",
          content:
            "Scout this feature and record the demo script. You are being filmed.",
        },
      ],
      max_iterations: budget,
    });

    let turns = 0;
    let lastStop: string | null = null;
    let toolCalls = 0;
    try {
      for await (const message of runner) {
        turns += 1;
        lastStop = message.stop_reason ?? null;
        reportUsage("scout", message.usage);
        for (const block of message.content) {
          if (block.type === "text" && block.text.trim()) {
            log.detail(dim(`  ${block.text.trim().split("\n")[0]}`));
          }
          if (block.type === "tool_use") {
            toolCalls += 1;
            if (process.env.VDG_TRACE) log.detail(dim(`    · ${block.name}`));
          }
        }
        if (session.finished) break;
      }
    } catch (error) {
      // The steps recorded so far are already on film, and the film is the
      // expensive part. A model call that fails afterwards - an expired key, a
      // spent credit balance, a dropped connection - used to throw the whole
      // session away and leave an orphaned recording with no shot list beside
      // it. Keep what was recorded and cut the demo short instead.
      if (session.steps.length === 0) throw error;
      log.warn(
        `The scout stopped early after ${fmtCount(session.steps.length, "recorded step")}: ` +
          (error as Error).message.split("\n")[0],
      );
      log.detail(dim("  Cutting the demo from the steps it did record."));
    }

    if (session.steps.length === 0) {
      // Three very different failures used to share one message, which sent
      // the reader looking at the recorder when the fault was elsewhere.
      const why =
        turns >= budget
          ? `It used all ${budget} turns exploring and never started recording. ` +
            `Re-run with --max-turns above ${budget}.`
          : session.finished
            ? `It called finish after ${turns} turns without recording anything` +
              (session.summary ? `: "${session.summary}"` : ".")
            : `It stopped after ${turns} turns and ${fmtCount(toolCalls, "tool call")} ` +
              `(stop_reason: ${lastStop ?? "unknown"}), without recording anything ` +
              "or calling finish. Re-run with VDG_TRACE=1 to see which tools it used.";
      throw new Error(`The scout recorded no steps, so there is nothing to cut. ${why}`);
    }
    log.ok(`Recorded ${fmtCount(session.steps.length, "step")} on camera`);

    // Let the final state sit for a moment before the camera stops.
    await page.waitForTimeout(1_200);
    const last = session.segments.at(-1);
    if (last) last.endMs = Date.now() - videoOrigin;

    const video = page.video();
    await context.close(); // flushes the webm
    if (!video) throw new Error("Playwright recorded no video for this session.");

    const script: DemoScript = {
      slug: storyboard.slug,
      request: storyboard.request,
      ...(storyboard.featureId ? { featureId: storyboard.featureId } : {}),
      featureName: storyboard.featureName,
      product: storyboard.product,
      profile: storyboard.profile,
      startUrl: storyboard.startUrl,
      createdAt: nowIso(),
      divergences: session.divergences,
      steps: session.steps,
    };

    return {
      script,
      segments: session.segments,
      videoPath: await video.path(),
      introMs,
    };
  } finally {
    await browser.close();
  }
}
