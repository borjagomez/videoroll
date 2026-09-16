import type { Browser, BrowserContext } from "playwright";
import {
  getClient,
  buildSystem,
  reportUsage,
  CACHE_CONVERSATION,
  CONTEXT_MANAGEMENT_BETA,
  FORGET_STALE_SCREENS,
} from "../llm/client.js";
import { MODEL, EFFORT } from "../config.js";
import { launch, newContext } from "../browser.js";
import { storageStatePath } from "../paths.js";
import { nowIso } from "../io.js";
import { ScoutSession } from "./tools.js";
import { replay } from "../record/replay.js";
import { describe } from "./locator.js";
import type { AppMap, DemoScript, Step, Storyboard } from "../types.js";
import { log, dim, fmtCount } from "../log.js";

export const SCOUT_INSTRUCTIONS = `You are scouting a live product so a demo video can be recorded of it.

You have a storyboard drafted from the product's documentation, a map of its
navigation, and a real browser session already signed in to a demo environment.
The documentation may be wrong or out of date. The running product is the truth.

Your job is to perform the feature yourself and record the exact steps that
worked, so a later stage can replay them in front of a camera.

How to work:
- Start with snapshot to see where you are.
- Follow the storyboard, but adapt. If a button is named differently, use the
  real name. If a step does not exist, skip it. If the flow needs a step the
  docs omitted, add it and call note_divergence.
- Explore with record:false. Once you know the path, perform it with record:true.
  Every recorded step must be one a viewer should watch.
- Only record actions that succeeded. If something fails, do not record it.
- Honour the storyboard's notes. In particular, when the notes say to demo as a
  particular person and the screen makes you choose a person, choose that
  person - picking someone else quietly turns a self-service demo into an
  administrative one.
- Write narration as you go, addressed to the viewer, present tense, describing
  what is happening and why it matters - not "click the button" but "approving
  it updates her balance and sends the confirmation". One sentence per step.
- Captions are two to five words, like a chapter title.
- Finish on the outcome: the confirmation message, the changed status, the new
  row. Use wait_for to hold on it so the viewer sees the result.
- Call finish when the demo is complete.

Constraints:
- This is a disposable demo environment. You may create, edit and delete freely.
- Keep the demo tight - somewhere between 4 and 10 recorded steps.
- Never record an exploratory detour, a wrong turn, or a step that only undoes
  another. The recording must read as one confident pass.`;

export function renderStoryboard(storyboard: Storyboard): string {
  return [
    `feature: ${storyboard.featureName}`,
    `request: ${storyboard.request}`,
    `suggested start url: ${storyboard.startUrl}`,
    storyboard.notes ? `notes: ${storyboard.notes}` : "",
    "",
    "storyboard (a hypothesis from the docs - verify it):",
    ...storyboard.scenes.map(
      (scene, i) =>
        `  ${i + 1}. ${scene.intent}\n     action: ${scene.docAction}\n     narration beat: ${scene.narrationBeat}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderAppMap(appMap: AppMap): string {
  return [
    `app base url: ${appMap.baseUrl}`,
    "navigation:",
    ...appMap.routes.map(
      (r) =>
        `  - ${r.label}${r.url ? ` → ${r.url}` : " (button)"}` +
        (r.description ? ` — ${r.description}` : ""),
    ),
  ].join("\n");
}

function renderSteps(steps: Step[]): string {
  if (steps.length === 0) return "(nothing recorded yet)";
  return steps
    .map(
      (s) =>
        `  ${s.id}. ${s.action}` +
        (s.locator ? ` ${describe(s.locator)}` : "") +
        (s.url ? ` ${s.url}` : "") +
        (s.value ? ` = "${s.value}"` : "") +
        (s.waitForText ? ` until "${s.waitForText}"` : ""),
    )
    .join("\n");
}

export interface ScoutOptions {
  storyboard: Storyboard;
  appMap: AppMap;
  profile: string;
  /** Watch it work. Slower, but the only way to see what it is doing. */
  headed?: boolean;
  maxRounds?: number;
  maxIterations?: number;
}

interface RoundResult {
  steps: Step[];
  divergences: string[];
  summary: string;
}

async function runRound(
  browser: Browser,
  options: ScoutOptions,
  seedSteps: Step[],
  problem: string | null,
): Promise<RoundResult> {
  const { storyboard, appMap, profile } = options;
  const context: BrowserContext = await newContext(browser, {
    storageStatePath: storageStatePath(profile),
  });
  const page = await context.newPage();

  try {
    await page.goto(storyboard.startUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    const session = new ScoutSession(page, storyboard.startUrl);

    // A repair round re-enters with the steps that already replayed cleanly,
    // and the browser put back into the state they leave the app in.
    if (seedSteps.length > 0) {
      session.seed(seedSteps);
      await replay({
        page,
        steps: seedSteps,
        startUrl: storyboard.startUrl,
        cinematic: false,
      });
    }

    const user = problem
      ? [
          `Recorded so far:`,
          renderSteps(seedSteps),
          ``,
          `Replaying that script from a clean session failed:`,
          problem,
          ``,
          `The browser is now in the state those steps leave behind. Work out what`,
          `actually happens here and record the remaining steps so the whole script`,
          `replays cleanly from the start.`,
        ].join("\n")
      : `Scout this feature and record the demo script.`;

    const runner = getClient().beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 16000,
      system: buildSystem({
        cachedPrefix: [renderStoryboard(storyboard), renderAppMap(appMap)].join("\n\n"),
        instructions: SCOUT_INSTRUCTIONS,
        user: "",
      }),
      output_config: { effort: EFFORT },
      cache_control: CACHE_CONVERSATION,
      betas: [CONTEXT_MANAGEMENT_BETA],
      context_management: FORGET_STALE_SCREENS,
      tools: session.tools(),
      messages: [{ role: "user", content: user }],
      max_iterations: options.maxIterations ?? 50,
    });

    for await (const message of runner) {
      reportUsage("scout", message.usage);
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) {
          log.detail(dim(`  ${block.text.trim().split("\n")[0]}`));
        }
      }
      if (session.finished) break;
      if (session.stalled) {
        log.warn(
          `The scout stopped making progress - the screen stopped responding ` +
            `to it while it was doing this: ${session.stalledOn}`,
        );
        break;
      }
    }

    if (!session.finished && session.steps.length === 0) {
      throw new Error(
        (session.stalled
          ? `The scout got stuck and recorded no step. The last thing it tried, ` +
            `repeatedly and with no effect on the screen, was: ${session.stalledOn}. ` +
            `That control is the thing to look at.`
          : `The scout stopped without recording any step.`) +
          ` Re-run with --headed to watch what it is seeing.`,
      );
    }

    return {
      steps: session.steps,
      divergences: session.divergences,
      summary: session.summary,
    };
  } finally {
    await context.close();
  }
}

/** Replays a script from a clean session - the only proof it actually works. */
async function verify(
  browser: Browser,
  profile: string,
  startUrl: string,
  steps: Step[],
): Promise<string | null> {
  const context = await newContext(browser, {
    storageStatePath: storageStatePath(profile),
  });
  const page = await context.newPage();
  try {
    const result = await replay({ page, steps, startUrl, cinematic: false });
    if (result.ok) return null;
    const { step, index, message } = result.failure!;
    return (
      `Step ${step.id} (${index + 1} of ${steps.length}) — ${step.action}` +
      (step.locator ? ` on ${describe(step.locator)}` : "") +
      `: ${message}`
    );
  } finally {
    await context.close();
  }
}

export async function scout(options: ScoutOptions): Promise<DemoScript> {
  const { storyboard } = options;
  const maxRounds = options.maxRounds ?? 3;
  const browser = await launch(!options.headed);

  try {
    let seed: Step[] = [];
    let problem: string | null = null;

    for (let round = 1; round <= maxRounds; round++) {
      log.step(
        round === 1
          ? "Scouting the live product"
          : `Repair round ${round - 1}: fixing the script`,
      );

      const result = await runRound(browser, options, seed, problem);
      log.ok(`Recorded ${fmtCount(result.steps.length, "step")}`);

      log.step("Verifying the script replays from a clean session");
      const failure = await verify(
        browser,
        options.profile,
        storyboard.startUrl,
        result.steps,
      );

      if (!failure) {
        log.ok("Script replays cleanly");
        return {
          slug: storyboard.slug,
          request: storyboard.request,
          ...(storyboard.featureId ? { featureId: storyboard.featureId } : {}),
          featureName: storyboard.featureName,
          product: storyboard.product,
          profile: storyboard.profile,
          startUrl: storyboard.startUrl,
          createdAt: nowIso(),
          divergences: result.divergences,
          steps: result.steps,
        };
      }

      log.warn(failure);
      if (round === maxRounds) {
        throw new Error(
          `The script still does not replay after ${maxRounds} rounds.\n  ${failure}\n` +
            `  Re-run with --headed to watch, or edit the steps by hand and use ` +
            `\`vdg replay <slug>\`.`,
        );
      }

      // Carry forward only the prefix that demonstrably works.
      const failedAt = result.steps.findIndex((s) => failure.startsWith(`Step ${s.id} `));
      seed = failedAt > 0 ? result.steps.slice(0, failedAt) : [];
      problem = failure;
    }

    throw new Error("unreachable");
  } finally {
    await browser.close();
  }
}
