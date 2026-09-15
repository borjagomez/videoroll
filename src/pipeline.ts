import fs from "node:fs";
import path from "node:path";
import { buildStoryboard } from "./scout/storyboard.js";
import { scout } from "./scout/scout.js";
import { scoutOneShot } from "./scout/oneshot.js";
import { narrate } from "./narrate/script.js";
import { capture } from "./record/capture.js";
import { recut } from "./compose/recut.js";
import { compose } from "./compose/compose.js";
import { sessionIsValid, login } from "./app/auth.js";
import {
  featureCatalogPath,
  appMapPath,
  storageStatePath,
  storyboardPath,
  stepsPath,
  narrationPath,
  timelinePath,
  sessionCutPath,
  outDir,
} from "./paths.js";
import { readArtifact, writeArtifact, slugify, nowIso } from "./io.js";
import {
  FeatureCatalogSchema,
  AppMapSchema,
  StoryboardSchema,
  DemoScriptSchema,
  NarrationSchema,
  TimelineSchema,
  SessionCutSchema,
  type DemoScript,
  type Storyboard,
} from "./types.js";
import { log } from "./log.js";

/**
 * Running a demo, separated from printing one.
 *
 * The CLI wants an exit code and pretty output; the server wants an object and a
 * stream of progress. Both want exactly the same pipeline, so it lives here and
 * each surface is a thin wrapper.
 */

export interface RunDemoOptions {
  request: string;
  product: string;
  profile: string;
  /** Skip matching and use this catalog feature. */
  featureId?: string;
  /** Use an existing steps.json instead of scouting. */
  stepsFile?: string;
  /** Scout and film in one execution, for features that cannot be replayed. */
  onePass?: boolean;
  /** No voiceover; subtitles and pacing still generated. */
  silent?: boolean;
  /** Skip the narration polish pass. */
  rawNarration?: boolean;
  burnSubs?: boolean;
  headed?: boolean;
  crf?: number;
  /** Turns a filmed one-pass session may take before it gives up. */
  maxTurns?: number;
}

export interface DemoResult {
  slug: string;
  featureName: string;
  videoPath: string;
  srtPath: string;
  vttPath: string;
  thumbnailPath: string;
  durationMs: number;
  stepCount: number;
  /** Where the live product disagreed with its documentation. */
  divergences: string[];
  /** True when nothing was rendered because it already existed. */
  reused: boolean;
}

/** Everything a demo needs before it can be rendered. */
export function assertReady(product: string, profile: string): void {
  if (!fs.existsSync(featureCatalogPath(product))) {
    throw new Error(
      `No feature catalog for "${product}". Run \`vdg learn <docs-url> --product ${product}\` first.`,
    );
  }
  if (!fs.existsSync(storageStatePath(profile))) {
    throw new Error(
      `No saved session for profile "${profile}". Run \`vdg connect\` first.`,
    );
  }
}

/**
 * Make sure the saved session still gets into the product.
 *
 * A lapsed session makes every locator time out, which reads as a broken script
 * rather than an expired cookie. Checking first turns a confusing failure into a
 * few seconds of signing back in.
 */
export async function ensureSession(
  profile: string,
  appUrl: string,
): Promise<void> {
  if (await sessionIsValid(profile, appUrl)) return;

  log.step("Session has expired - signing in again");
  const { browser } = await login({ appUrl, profile });
  await browser.close();
  log.ok("Session refreshed");
}

async function buildScript(
  options: RunDemoOptions,
): Promise<{ script: DemoScript; storyboard?: Storyboard }> {
  if (options.stepsFile) {
    return { script: readArtifact(options.stepsFile, DemoScriptSchema) };
  }

  const catalog = readArtifact(featureCatalogPath(options.product), FeatureCatalogSchema);
  const appMap = readArtifact(appMapPath(options.profile), AppMapSchema);

  const storyboard = await buildStoryboard({
    request: options.request,
    product: options.product,
    profile: options.profile,
    catalog,
    appMap,
    ...(options.featureId ? { featureId: options.featureId } : {}),
  });
  writeArtifact(storyboardPath(storyboard.slug), StoryboardSchema, storyboard);

  if (options.onePass) {
    const shot = await scoutOneShot({
      storyboard,
      appMap,
      profile: options.profile,
      ...(options.headed !== undefined ? { headed: options.headed } : {}),
      ...(options.maxTurns !== undefined ? { maxIterations: options.maxTurns } : {}),
    });
    writeArtifact(stepsPath(shot.script.slug), DemoScriptSchema, shot.script);
    writeArtifact(sessionCutPath(shot.script.slug), SessionCutSchema, {
      slug: shot.script.slug,
      sourceVideo: shot.videoPath,
      introMs: shot.introMs,
      recordedAt: nowIso(),
      segments: shot.segments,
    });
    return { script: shot.script, storyboard };
  }

  const script = await scout({
    storyboard,
    appMap,
    profile: options.profile,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  writeArtifact(stepsPath(script.slug), DemoScriptSchema, script);
  return { script, storyboard };
}

export async function runDemo(options: RunDemoOptions): Promise<DemoResult> {
  assertReady(options.product, options.profile);

  const appMap = fs.existsSync(appMapPath(options.profile))
    ? readArtifact(appMapPath(options.profile), AppMapSchema)
    : null;
  if (appMap) await ensureSession(options.profile, appMap.baseUrl);

  const { script } = await buildScript(options);

  if (script.divergences.length > 0) {
    log.warn("The live product differs from the documentation:");
    for (const note of script.divergences) log.detail(`· ${note}`);
  }

  const narration = await narrate({
    script,
    ...(options.silent ? { silent: true } : {}),
    ...(options.rawNarration ? { skipPolish: true } : {}),
  });
  writeArtifact(narrationPath(script.slug), NarrationSchema, narration);

  // One-pass already has its footage; it is cut to the narration rather than
  // filmed against it.
  let videoPath: string;
  let timeline;
  if (options.onePass && !options.stepsFile) {
    const cut = readArtifact(sessionCutPath(script.slug), SessionCutSchema);
    const result = await recut({
      slug: script.slug,
      sourceVideo: cut.sourceVideo,
      segments: cut.segments,
      narration,
      introMs: cut.introMs,
    });
    videoPath = result.videoPath;
    timeline = result.timeline;
  } else {
    const result = await capture({
      script,
      narration,
      ...(options.headed !== undefined ? { headed: options.headed } : {}),
    });
    videoPath = result.videoPath;
    timeline = result.timeline;
  }
  writeArtifact(timelinePath(script.slug), TimelineSchema, timeline);

  const composed = await compose({
    script,
    narration,
    timeline,
    videoPath,
    ...(options.burnSubs ? { burnSubs: true } : {}),
    ...(options.crf !== undefined ? { crf: options.crf } : {}),
  });

  return {
    slug: script.slug,
    featureName: script.featureName,
    videoPath: composed.mp4,
    srtPath: composed.srt,
    vttPath: composed.vtt,
    thumbnailPath: composed.thumbnail,
    durationMs: timeline.totalMs,
    stepCount: script.steps.length,
    divergences: script.divergences,
    reused: false,
  };
}

/** A demo that has already been rendered, if there is one. */
export function findRendered(slug: string): DemoResult | null {
  const dir = outDir(slug);
  const mp4 = path.join(dir, "demo.mp4");
  if (!fs.existsSync(mp4)) return null;

  const steps = stepsPath(slug);
  const timeline = timelinePath(slug);
  if (!fs.existsSync(steps) || !fs.existsSync(timeline)) return null;

  const script = readArtifact(steps, DemoScriptSchema);
  const line = readArtifact(timeline, TimelineSchema);

  return {
    slug,
    featureName: script.featureName,
    videoPath: mp4,
    srtPath: path.join(dir, "demo.srt"),
    vttPath: path.join(dir, "demo.vtt"),
    thumbnailPath: path.join(dir, "thumbnail.png"),
    durationMs: line.totalMs,
    stepCount: script.steps.length,
    divergences: script.divergences,
    reused: true,
  };
}

export const demoSlug = (name: string) => slugify(name);
