import fs from "node:fs";
import { buildStoryboard } from "../scout/storyboard.js";
import { scout } from "../scout/scout.js";
import { scoutOneShot } from "../scout/oneshot.js";
import { recut } from "../compose/recut.js";
import { narrate } from "../narrate/script.js";
import { capture } from "../record/capture.js";
import { compose } from "../compose/compose.js";
import {
  featureCatalogPath,
  appMapPath,
  storageStatePath,
  storyboardPath,
  stepsPath,
  narrationPath,
  timelinePath,
  sessionCutPath,
  rel,
} from "../paths.js";
import { readArtifact, writeArtifact, slugify, nowIso } from "../io.js";
import {
  FeatureCatalogSchema,
  AppMapSchema,
  StoryboardSchema,
  DemoScriptSchema,
  NarrationSchema,
  TimelineSchema,
  SessionCutSchema,
  type AppMap,
  type DemoScript,
  type Storyboard,
} from "../types.js";
import { log, bold, dim } from "../log.js";

export interface RecordOptions {
  product: string;
  profile: string;
  feature?: string;
  /** Use an existing steps.json instead of scouting. */
  steps?: string;
  /** Commander sets this to false for `--no-voice`. */
  voice?: boolean;
  burnSubs?: boolean;
  headed?: boolean;
  /** Match the feature and print the storyboard, then stop. */
  rawNarration?: boolean;
  /**
   * Scout and film in a single execution, for features that cannot survive
   * being run three times. Trades the verification replay for a take of the
   * feature actually working.
   */
  onePass?: boolean;
  dryRun?: boolean;
  crf?: number;
}

export async function record(request: string, options: RecordOptions): Promise<number> {
  const product = slugify(options.product);
  const profile = slugify(options.profile);

  if (!fs.existsSync(storageStatePath(profile))) {
    throw new Error(
      `No saved session for profile "${profile}". Run \`vdg connect\` first.`,
    );
  }

  log.blank();
  log.info(`${bold("request")} ${request}`);
  log.info(`${bold("product")} ${product}   ${bold("profile")} ${profile}`);
  log.blank();

  let script: DemoScript;

  if (options.steps) {
    script = readArtifact(options.steps, DemoScriptSchema);
    log.ok(`Using the script at ${rel(options.steps)} (${script.steps.length} steps)`);
  } else {
    // Only needed when scouting - supplying --steps skips both.
    const catalog = readArtifact(featureCatalogPath(product), FeatureCatalogSchema);
    const appMap = readArtifact(appMapPath(profile), AppMapSchema);

    const storyboard = await buildStoryboard({
      request,
      product,
      profile,
      catalog,
      appMap,
      ...(options.feature ? { featureId: options.feature } : {}),
    });
    writeArtifact(storyboardPath(storyboard.slug), StoryboardSchema, storyboard);

    log.blank();
    log.info(`${bold(storyboard.featureName)}  ${dim(storyboard.startUrl)}`);
    for (const [i, scene] of storyboard.scenes.entries()) {
      log.detail(`  ${i + 1}. ${scene.intent} — ${scene.docAction}`);
    }
    log.blank();

    if (options.dryRun) {
      log.info(
        "Stopping here (--dry-run). Nothing was run against the demo environment.",
      );
      log.detail(`storyboard  ${rel(storyboardPath(storyboard.slug))}`);
      log.blank();
      return 0;
    }

    if (options.onePass) {
      return runOnePass({ storyboard, appMap, profile, options });
    }

    script = await scout({
      storyboard,
      appMap,
      profile,
      ...(options.headed !== undefined ? { headed: options.headed } : {}),
    });
    writeArtifact(stepsPath(script.slug), DemoScriptSchema, script);
    log.detail(`script  ${rel(stepsPath(script.slug))}`);

    if (script.divergences.length > 0) {
      log.blank();
      log.warn("The live product differs from the documentation:");
      for (const note of script.divergences) log.detail(`  · ${note}`);
    }
  }

  log.blank();
  const narration = await narrate({
    script,
    ...(options.voice === false ? { silent: true } : {}),
    ...(options.rawNarration ? { skipPolish: true } : {}),
  });
  writeArtifact(narrationPath(script.slug), NarrationSchema, narration);

  log.blank();
  const { timeline, videoPath } = await capture({
    script,
    narration,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  writeArtifact(timelinePath(script.slug), TimelineSchema, timeline);

  log.blank();
  await compose({
    script,
    narration,
    timeline,
    videoPath,
    ...(options.burnSubs ? { burnSubs: true } : {}),
    ...(options.crf !== undefined ? { crf: options.crf } : {}),
  });
  log.blank();
  return 0;
}

interface OnePassInput {
  storyboard: Storyboard;
  appMap: AppMap;
  profile: string;
  options: RecordOptions;
}

/**
 * Scout, film, narrate and cut in a single execution of the demo.
 *
 * The order differs from the three-pass route out of necessity: there the
 * narration is written first and the camera holds each step for its line, but
 * here the action has already happened by the time there is a script to narrate.
 * So the lines are written after the fact and each shot is padded to fit.
 */
async function runOnePass({
  storyboard,
  appMap,
  profile,
  options,
}: OnePassInput): Promise<number> {
  log.info(
    "One-pass: the scout is filmed live, and only the steps it records are kept. " +
      "There is no verification replay — that is the point.",
  );
  log.blank();

  const shot = await scoutOneShot({
    storyboard,
    appMap,
    profile,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  writeArtifact(stepsPath(shot.script.slug), DemoScriptSchema, shot.script);
  log.detail(`script  ${rel(stepsPath(shot.script.slug))}`);

  // The footage cost a live run; keep the cut points so it can be re-cut.
  writeArtifact(sessionCutPath(shot.script.slug), SessionCutSchema, {
    slug: shot.script.slug,
    sourceVideo: shot.videoPath,
    introMs: shot.introMs,
    recordedAt: nowIso(),
    segments: shot.segments,
  });

  if (shot.script.divergences.length > 0) {
    log.blank();
    log.warn("The live product differs from the documentation:");
    for (const note of shot.script.divergences) log.detail(`  · ${note}`);
  }

  log.blank();
  const narration = await narrate({
    script: shot.script,
    ...(options.voice === false ? { silent: true } : {}),
    ...(options.rawNarration ? { skipPolish: true } : {}),
  });
  writeArtifact(narrationPath(shot.script.slug), NarrationSchema, narration);

  log.blank();
  const { videoPath, timeline } = await recut({
    slug: shot.script.slug,
    sourceVideo: shot.videoPath,
    segments: shot.segments,
    narration,
    introMs: shot.introMs,
  });
  writeArtifact(timelinePath(shot.script.slug), TimelineSchema, timeline);

  log.blank();
  await compose({
    script: shot.script,
    narration,
    timeline,
    videoPath,
    ...(options.burnSubs ? { burnSubs: true } : {}),
    ...(options.crf !== undefined ? { crf: options.crf } : {}),
  });
  log.blank();
  return 0;
}
