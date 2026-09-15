import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { structured } from "../llm/client.js";
import { config } from "../config.js";
import { pagesDir, docIndexPath } from "../paths.js";
import { readArtifact, slugify, nowIso } from "../io.js";
import { DocIndexSchema, type AppMap, type FeatureCatalog, type Feature, type Storyboard } from "../types.js";
import { log, dim, fmtCount } from "../log.js";

const MatchSchema = z.object({
  featureId: z
    .string()
    .describe("id of the best matching feature, or the empty string if none fits"),
  confidence: z.enum(["high", "medium", "low", "none"]),
  reasoning: z.string().describe("One sentence on why this is the match"),
});

const StoryboardDraftSchema = z.object({
  featureName: z.string().describe("The feature as the demo will present it"),
  startUrl: z.string().describe("Absolute URL the demo should open on"),
  scenes: z
    .array(
      z.object({
        intent: z.string().describe("What the viewer should understand from this scene"),
        docAction: z.string().describe("The concrete UI action, from the docs or the app map"),
        narrationBeat: z.string().describe("Roughly what the voiceover says here"),
        sourceUrl: z.string().describe("Documentation URL this came from, or empty"),
      }),
    )
    .min(1),
  notes: z.string().describe("Anything the scout should watch out for, or empty"),
});

const MATCH_INSTRUCTIONS = `You match a user's plain-language request to one feature in a product's catalog.

Pick the single feature whose task the request is asking to see demonstrated.
Prefer the feature whose *actor* matches: "approve a time off request" is the
manager's approval feature, not the employee's request feature.

Set confidence to "none" and featureId to "" only when nothing in the catalog
covers the request at all - not merely when the wording differs.`;

const STORYBOARD_INSTRUCTIONS = `You are drafting the shot list for a short product demo video.

Write every intent and narration beat in LANGUAGE. Quote UI labels exactly as
they appear in the application, in the application's own language, even when
that differs from LANGUAGE - the viewer is looking at that interface. Do not
translate a button's label; name it as it is written on screen.

You have the documentation for one feature and a map of the live application's
navigation. Produce an ordered list of scenes covering the feature from an
obvious starting point through to the result the viewer should see.

Rules:
- Demo the task the request asks for, performed by the person who would ask for
  it. When the documentation covers both configuring a feature and using it,
  and the request is phrased as using it ("clock in", "request time off"), show
  the everyday action - not the admin setup behind it. Include a configuration
  step only when the request is about setting the feature up, or when the
  feature is genuinely unusable without showing one.
- Start where a viewer would start: a list or dashboard screen, not mid-flow.
- One scene per meaningful UI action. Do not merge "open the screen" and "click
  the button" into one scene.
- End on the outcome - the confirmation, the changed status, the new row. A demo
  that stops at the click has not shown the feature working.
- startUrl must come from the app map. If several fit, choose the screen where
  the feature begins.
- This is a hypothesis drawn from documentation that may be out of date. A later
  stage drives the real product and corrects you. Prefer being specific and
  wrong over being vague.
- Aim for 4 to 8 scenes. Fewer if the feature is genuinely two clicks.`;

function renderCatalog(catalog: FeatureCatalog): string {
  return catalog.features
    .map((f) =>
      [
        `id: ${f.id}`,
        `name: ${f.name}`,
        f.aliases.length > 0 ? `aliases: ${f.aliases.join(", ")}` : "",
        `category: ${f.category}`,
        `summary: ${f.summary}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

function renderAppMap(appMap: AppMap): string {
  return [
    `base url: ${appMap.baseUrl}`,
    "navigation:",
    ...appMap.routes.map(
      (r) =>
        `  - ${r.label}${r.url ? ` → ${r.url}` : " (button, no URL)"}` +
        (r.description ? `\n      ${r.description}` : ""),
    ),
  ].join("\n");
}

/** The full text of the articles this feature was drawn from. */
function loadSourceDocs(product: string, feature: Feature): string {
  if (feature.sourceUrls.length === 0) return "";
  const index = readArtifact(docIndexPath(product), DocIndexSchema);
  const wanted = new Set(feature.sourceUrls);
  const parts: string[] = [];
  for (const page of index.pages) {
    if (!wanted.has(page.url)) continue;
    const file = path.join(pagesDir(product), page.file);
    if (!fs.existsSync(file)) continue;
    parts.push(`<article url="${page.url}" title="${page.title}">\n${fs.readFileSync(file, "utf8")}\n</article>`);
  }
  return parts.join("\n\n");
}

export interface StoryboardInput {
  request: string;
  product: string;
  profile: string;
  catalog: FeatureCatalog;
  appMap: AppMap;
  /** Skip matching and use this feature. */
  featureId?: string;
}

export async function buildStoryboard(input: StoryboardInput): Promise<Storyboard> {
  const { catalog, appMap, request } = input;

  let feature: Feature | undefined;
  if (input.featureId) {
    feature = catalog.features.find((f) => f.id === input.featureId);
    if (!feature) {
      throw new Error(
        `No feature with id "${input.featureId}". Run: vdg features --product ${input.product}`,
      );
    }
  } else {
    log.step(`Matching "${request}" against ${fmtCount(catalog.features.length, "feature")}`);
    const match = await structured(
      "match",
      {
        cachedPrefix: renderCatalog(catalog),
        instructions: MATCH_INSTRUCTIONS,
        user: `Request: ${request}`,
      },
      MatchSchema,
    );
    feature = catalog.features.find((f) => f.id === match.featureId);
    if (feature) {
      log.ok(`Matched ${feature.name} ${dim(`(${match.confidence}: ${match.reasoning})`)}`);
    } else {
      log.warn(
        `No catalogued feature matches. Scouting from the request and the app map alone.`,
      );
    }
  }

  const docs = feature ? loadSourceDocs(input.product, feature) : "";
  const featureBrief = feature
    ? [
        `feature: ${feature.name}`,
        `summary: ${feature.summary}`,
        feature.prerequisites.length > 0
          ? `prerequisites: ${feature.prerequisites.join("; ")}`
          : "",
        feature.docSteps.length > 0
          ? `documented steps:\n${feature.docSteps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : `The request did not match any catalogued feature. Work from the request and the app map.`;

  log.step("Drafting the storyboard");
  const draft = await structured(
    "storyboard",
    {
      cachedPrefix: [docs, renderAppMap(appMap)].filter(Boolean).join("\n\n"),
      instructions: STORYBOARD_INSTRUCTIONS.replaceAll(
        "LANGUAGE",
        config.narration.language,
      ),
      user: `Request: ${request}\n\n${featureBrief}`,
    },
    StoryboardDraftSchema,
  );

  const slug = slugify(feature ? feature.name : request);
  return {
    slug,
    request,
    product: input.product,
    profile: input.profile,
    ...(feature ? { featureId: feature.id } : {}),
    featureName: draft.featureName || feature?.name || request,
    startUrl: draft.startUrl,
    createdAt: nowIso(),
    scenes: draft.scenes.map((scene) => ({
      intent: scene.intent,
      docAction: scene.docAction,
      narrationBeat: scene.narrationBeat,
      ...(scene.sourceUrl ? { sourceUrl: scene.sourceUrl } : {}),
    })),
    ...(draft.notes ? { notes: draft.notes } : {}),
  };
}
