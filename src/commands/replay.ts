import fs from "node:fs";
import { launch, newContext } from "../browser.js";
import { replay as replaySteps } from "../record/replay.js";
import { narrate } from "../narrate/script.js";
import { capture } from "../record/capture.js";
import { compose } from "../compose/compose.js";
import { describe } from "../scout/locator.js";
import {
  stepsPath,
  narrationPath,
  timelinePath,
  storageStatePath,
  rel,
} from "../paths.js";
import { readArtifact, writeArtifact } from "../io.js";
import { DemoScriptSchema, NarrationSchema, TimelineSchema } from "../types.js";
import { log, bold, dim, fmtCount } from "../log.js";

export interface ReplayCommandOptions {
  /** Check the script still works; do not record anything. */
  verify?: boolean;
  /** Re-run text-to-speech instead of reusing narration.json. */
  revoice?: boolean;
  /** Commander sets this to false for `--no-voice`. */
  voice?: boolean;
  rawNarration?: boolean;
  burnSubs?: boolean;
  headed?: boolean;
}

export async function replayCommand(
  slug: string,
  options: ReplayCommandOptions,
): Promise<number> {
  const script = readArtifact(stepsPath(slug), DemoScriptSchema);
  log.blank();
  log.info(`${bold(script.featureName)}  ${fmtCount(script.steps.length, "step")}`);

  if (options.verify) {
    log.step("Replaying against the live product");
    const browser = await launch(!options.headed);
    try {
      const context = await newContext(browser, {
        storageStatePath: storageStatePath(script.profile),
      });
      const page = await context.newPage();
      const result = await replaySteps({
        page,
        steps: script.steps,
        startUrl: script.startUrl,
        cinematic: false,
      });
      log.blank();
      if (result.ok) {
        log.ok("The script still replays cleanly.");
        return 0;
      }
      const { step, index, message } = result.failure!;
      log.error(
        `Step ${step.id} (${index + 1}/${script.steps.length}) ${step.action}` +
          (step.locator ? ` on ${describe(step.locator)}` : "") +
          `: ${message}`,
      );
      log.detail(
        `The product has drifted from this script. Re-run \`vdg record\` to ` +
          `re-scout it, or edit ${rel(stepsPath(slug))} by hand.`,
      );
      return 1;
    } finally {
      await browser.close();
    }
  }

  // Re-record from the script as it stands on disk, edits included.
  const existing = narrationPath(slug);
  const narration =
    !options.revoice && fs.existsSync(existing)
      ? readArtifact(existing, NarrationSchema)
      : await narrate({
          script,
          ...(options.voice === false ? { silent: true } : {}),
          ...(options.rawNarration ? { skipPolish: true } : {}),
        });

  if (options.revoice || !fs.existsSync(existing)) {
    writeArtifact(existing, NarrationSchema, narration);
  } else {
    log.detail(dim(`reusing ${rel(existing)} — pass --revoice to redo the voiceover`));
  }

  // A hand-edited script can add or remove steps; narration must still cover them.
  const covered = new Set(narration.steps.map((s) => s.stepId));
  const missing = script.steps.filter((s) => !covered.has(s.id));
  if (missing.length > 0) {
    throw new Error(
      `narration.json has no line for ${fmtCount(missing.length, "step")} ` +
        `(${missing.map((s) => s.id).join(", ")}). Re-run with --revoice.`,
    );
  }

  log.blank();
  const { timeline, videoPath } = await capture({
    script,
    narration,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  writeArtifact(timelinePath(slug), TimelineSchema, timeline);

  log.blank();
  await compose({
    script,
    narration,
    timeline,
    videoPath,
    ...(options.burnSubs ? { burnSubs: true } : {}),
  });
  log.blank();
  return 0;
}
