import { buildStoryboard } from "../scout/storyboard.js";
import { runDemo, assertReady, type RunDemoOptions } from "../pipeline.js";
import { featureCatalogPath, appMapPath, storyboardPath, rel } from "../paths.js";
import { readArtifact, writeArtifact, slugify } from "../io.js";
import {
  FeatureCatalogSchema,
  AppMapSchema,
  StoryboardSchema,
} from "../types.js";
import { log, bold, dim, fmtDuration } from "../log.js";

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

/**
 * The CLI face of `runDemo` - argument shuffling and pretty output, nothing
 * else. The pipeline itself lives in src/pipeline.ts so the server runs the
 * identical code path.
 */
export async function record(request: string, options: RecordOptions): Promise<number> {
  const product = slugify(options.product);
  const profile = slugify(options.profile);
  assertReady(product, profile);

  log.blank();
  log.info(`${bold("request")} ${request}`);
  log.info(`${bold("product")} ${product}   ${bold("profile")} ${profile}`);
  log.blank();

  // A dry run stops before anything touches the demo environment, so it builds
  // the storyboard here rather than going near the pipeline.
  if (options.dryRun && !options.steps) {
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
      log.detail(`${i + 1}. ${scene.intent} — ${scene.docAction}`);
    }
    log.blank();
    log.info("Stopping here (--dry-run). Nothing was run against the demo environment.");
    log.detail(`storyboard  ${rel(storyboardPath(storyboard.slug))}`);
    log.blank();
    return 0;
  }

  if (options.onePass) {
    log.info(
      "One-pass: the scout is filmed live, and only the steps it records are kept. " +
        "There is no verification replay — that is the point.",
    );
    log.blank();
  }

  const run: RunDemoOptions = {
    request,
    product,
    profile,
    ...(options.feature ? { featureId: options.feature } : {}),
    ...(options.steps ? { stepsFile: options.steps } : {}),
    ...(options.onePass ? { onePass: true } : {}),
    ...(options.voice === false ? { silent: true } : {}),
    ...(options.rawNarration ? { rawNarration: true } : {}),
    ...(options.burnSubs ? { burnSubs: true } : {}),
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
    ...(options.crf !== undefined ? { crf: options.crf } : {}),
  };

  const result = await runDemo(run);

  log.blank();
  log.ok(`${result.featureName} — ${fmtDuration(result.durationMs)}`);
  log.info(`video      ${rel(result.videoPath)}`);
  log.info(`subtitles  ${rel(result.srtPath)}  ${dim("(also embedded in the mp4)")}`);
  log.info(`thumbnail  ${rel(result.thumbnailPath)}`);
  log.blank();
  return 0;
}
