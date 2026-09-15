import { z } from "zod";
import { structured, OutputTruncatedError } from "../llm/client.js";
import { slugify, nowIso } from "../io.js";
import { log, fmtCount } from "../log.js";
import type { ExtractedPage } from "./extract.js";
import type { Feature, FeatureCatalog } from "../types.js";

/**
 * Schemas the *model* fills in. Deliberately separate from the artifact
 * schemas in types.ts: every field is required and plainly typed, because
 * structured outputs are strictest - and cheapest to debug - that way. Ids and
 * timestamps are assigned in code, never by the model, so they stay stable
 * across re-runs.
 */
const FeatureDraftSchema = z.object({
  name: z.string().describe("The feature as a user would name it, e.g. 'Approve a time off request'"),
  aliases: z.array(z.string()).describe("Other names a user might search for"),
  summary: z.string().describe("One or two sentences on what it does and who uses it"),
  category: z.string().describe("Product area, e.g. 'Time off', 'Expenses', 'Payroll'"),
  docSteps: z.array(z.string()).describe("Ordered UI steps exactly as the documentation describes them"),
  prerequisites: z.array(z.string()).describe("What must be true first: a permission, a setting, existing data"),
  entities: z.array(z.string()).describe("Domain nouns the feature acts on"),
  sourceUrls: z.array(z.string()).describe("URLs of the pages this was drawn from"),
});

const DraftBatchSchema = z.object({
  features: z.array(FeatureDraftSchema),
});

/**
 * The reducer returns only its *decisions* - which drafts are the same feature -
 * not a rewritten catalog. Merging 139 drafts by re-emitting every field
 * overran the reply limit and made the model responsible for copying data it
 * had no reason to touch. Groups are a few tokens each, and the merge itself is
 * deterministic code below.
 */
const MergeGroupsSchema = z.object({
  groups: z
    .array(
      z.object({
        name: z.string().describe("The clearest user-facing name for the merged feature"),
        ids: z
          .array(z.string())
          .describe("Two or more draft ids that describe the same task"),
      }),
    )
    .describe("Only groups of two or more. Drafts you do not list are left alone."),
});

type FeatureDraft = z.infer<typeof FeatureDraftSchema>;

const MAP_INSTRUCTIONS = `You are cataloguing a software product's features from its help center.

From the documentation pages above, extract every distinct thing a user can DO in
the product. A feature is a task with a beginning and an end - "Approve a time off
request", "Export a payroll report" - not a concept ("What is a time off policy?")
and not a page title.

Rules:
- One entry per task. If several pages describe the same task, emit it once and
  list every source URL.
- docSteps must be the UI steps the documentation actually states, in order, in
  the documentation's own words. Do not invent steps, and do not smooth over a
  gap - a later stage verifies these against the live product and needs to know
  what the docs claimed.
- Skip pages that are pure navigation, marketing, pricing, changelogs, or FAQ
  entries with no procedure in them.
- If a page describes no actionable task, contribute nothing for it.`;

const REDUCE_INSTRUCTIONS = `You are de-duplicating feature drafts extracted from separate batches of the
same product's help center.

The same task often appears in several batches, worded differently. Find those
and group their ids together, choosing the clearest user-facing name for each
group.

- Only report groups of two or more ids. Anything you leave out stays as it is,
  so there is no need to list every draft.
- Group by TASK, not by topic. "Request time off" and "Approve a time off
  request" share a subject but have different actors and different outcomes -
  they are separate features and must not be merged.
- Two drafts describing the same task through different entry points (from the
  inbox, from the calendar) are the same feature - group them.
- Do not group a concept page with a procedure that merely mentions it.`;

/**
 * Batch size is bounded by the *output*, not the input: a batch of dense
 * how-to articles yields a feature every page or two, each with its full step
 * list, and 20 pages of that overran a 16k-token reply. Roughly ten pages per
 * call keeps the answer comfortably inside MAX_OUTPUT_TOKENS.
 */
const BATCH_CHARS = 55_000;
/** The SDK refuses a non-streaming request above this, so it is a hard ceiling. */
const MAX_OUTPUT_TOKENS = 16_000;

function batchPages(pages: ExtractedPage[]): ExtractedPage[][] {
  const batches: ExtractedPage[][] = [];
  let current: ExtractedPage[] = [];
  let size = 0;
  for (const page of pages) {
    const pageSize = page.markdown.length + page.url.length + 64;
    if (current.length > 0 && size + pageSize > BATCH_CHARS) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(page);
    size += pageSize;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function renderCorpus(pages: ExtractedPage[]): string {
  return pages
    .map(
      (p) =>
        `<page url="${p.url}" title="${p.title.replace(/"/g, "'")}">\n${p.markdown}\n</page>`,
    )
    .join("\n\n");
}

function toFeature(draft: FeatureDraft): Feature {
  return {
    id: slugify(draft.name),
    name: draft.name.trim(),
    aliases: [...new Set(draft.aliases.map((a) => a.trim()).filter(Boolean))],
    summary: draft.summary.trim(),
    category: draft.category.trim() || "General",
    sourceUrls: [...new Set(draft.sourceUrls.filter(Boolean))],
    docSteps: draft.docSteps.map((s) => s.trim()).filter(Boolean),
    prerequisites: draft.prerequisites.map((s) => s.trim()).filter(Boolean),
    entities: draft.entities.map((s) => s.trim()).filter(Boolean),
  };
}

/** Last line of defence: the reducer occasionally still emits a near-duplicate. */
function dedupeById(features: Feature[]): Feature[] {
  const byId = new Map<string, Feature>();
  for (const feature of features) {
    const existing = byId.get(feature.id);
    if (!existing) {
      byId.set(feature.id, feature);
      continue;
    }
    byId.set(feature.id, {
      ...existing,
      aliases: [...new Set([...existing.aliases, ...feature.aliases])],
      sourceUrls: [...new Set([...existing.sourceUrls, ...feature.sourceUrls])],
      docSteps:
        feature.docSteps.length > existing.docSteps.length
          ? feature.docSteps
          : existing.docSteps,
      prerequisites: [...new Set([...existing.prerequisites, ...feature.prerequisites])],
      entities: [...new Set([...existing.entities, ...feature.entities])],
    });
  }
  return [...byId.values()].sort(
    (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  );
}

/**
 * Extract one batch, halving and retrying if the reply overruns.
 *
 * How much output a batch produces depends on how dense the articles are, and
 * that cannot be known before reading them - a page of FAQ entries yields far
 * more features than a page of prose. Rather than pick a batch size small
 * enough for the worst case and pay for the extra calls every time, start
 * generous and split only the batches that actually overflow.
 */
async function distillBatch(
  batch: ExtractedPage[],
  label: string,
): Promise<FeatureDraft[]> {
  try {
    const result = await structured(
      `distill ${label}`,
      {
        // The corpus is the cached prefix: re-running `learn` within the hour
        // (a prompt tweak, an interrupted run) replays at cache rates.
        cachedPrefix: renderCorpus(batch),
        instructions: MAP_INSTRUCTIONS,
        user: `Extract the features documented in the ${batch.length} pages above.`,
        maxTokens: MAX_OUTPUT_TOKENS,
      },
      DraftBatchSchema,
    );
    return result.features;
  } catch (error) {
    if (!(error instanceof OutputTruncatedError) || batch.length < 2) {
      throw error;
    }
    const half = Math.ceil(batch.length / 2);
    log.warn(`${label} produced too much to return at once - splitting it in two`);
    return [
      ...(await distillBatch(batch.slice(0, half), `${label}a`)),
      ...(await distillBatch(batch.slice(half), `${label}b`)),
    ];
  }
}

/** Fold each group of duplicate drafts into one feature, keeping every source. */
function applyGroups(
  features: Feature[],
  groups: Array<{ name: string; ids: string[] }>,
): Feature[] {
  const byIndex = new Map(features.map((f, i) => [`d${i + 1}`, f]));
  const absorbed = new Set<string>();
  const merged: Feature[] = [];

  for (const group of groups) {
    const members = group.ids
      .filter((id) => !absorbed.has(id))
      .map((id) => byIndex.get(id))
      .filter((f): f is Feature => Boolean(f));
    if (members.length < 2) continue;
    for (const id of group.ids) absorbed.add(id);

    const primary =
      members.find((m) => m.name === group.name) ??
      members.reduce((best, m) => (m.docSteps.length > best.docSteps.length ? m : best));

    merged.push({
      ...primary,
      id: slugify(group.name || primary.name),
      name: group.name || primary.name,
      aliases: [
        ...new Set(
          members
            .flatMap((m) => [m.name, ...m.aliases])
            .filter((a) => a !== (group.name || primary.name)),
        ),
      ],
      sourceUrls: [...new Set(members.flatMap((m) => m.sourceUrls))],
      prerequisites: [...new Set(members.flatMap((m) => m.prerequisites))],
      entities: [...new Set(members.flatMap((m) => m.entities))],
    });
  }

  const untouched = features.filter((_, i) => !absorbed.has(`d${i + 1}`));
  return [...untouched, ...merged];
}

export async function distill(
  product: string,
  rootUrl: string,
  pages: ExtractedPage[],
): Promise<FeatureCatalog> {
  const batches = batchPages(pages);
  log.step(
    `Distilling ${fmtCount(pages.length, "page")} in ${fmtCount(batches.length, "batch", "batches")}`,
  );

  const drafts: FeatureDraft[] = [];
  for (const [index, batch] of batches.entries()) {
    const found = await distillBatch(batch, `batch ${index + 1}/${batches.length}`);
    log.detail(`batch ${index + 1}: ${fmtCount(found.length, "feature")}`);
    drafts.push(...found);
  }

  if (drafts.length === 0) {
    throw new Error(
      "No features were extracted. The crawl may have found only navigation " +
        "pages - check workspace/knowledge/<product>/pages/ and try a deeper " +
        "--max-pages or a more specific root URL.",
    );
  }

  let features = drafts.map(toFeature);

  if (batches.length > 1) {
    log.step(`De-duplicating ${fmtCount(drafts.length, "draft")} across batches`);
    const catalogue = drafts
      .map(
        (draft, i) =>
          `d${i + 1} | ${draft.category} | ${draft.name} | ${draft.summary}`,
      )
      .join("\n");

    const { groups } = await structured(
      "merge",
      {
        cachedPrefix: catalogue,
        instructions: REDUCE_INSTRUCTIONS,
        user: "Group the drafts above that describe the same task.",
        maxTokens: MAX_OUTPUT_TOKENS,
      },
      MergeGroupsSchema,
    );
    features = applyGroups(features, groups);
    log.detail(`${fmtCount(groups.length, "group")} merged`);
  }

  return {
    product,
    rootUrl,
    generatedAt: nowIso(),
    pageCount: pages.length,
    features: dedupeById(features),
  };
}
