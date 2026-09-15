import { featureCatalogPath, rel } from "../paths.js";
import { readArtifact, slugify } from "../io.js";
import { FeatureCatalogSchema, type Feature } from "../types.js";
import { log, bold, dim, fmtCount } from "../log.js";

export interface SearchResult {
  results: Feature[];
  /** Matches beyond MAX_RESULTS that were not returned. */
  truncated: number;
}

export function searchFeatures(features: Feature[], search: string): SearchResult {
  const phrase = search.toLowerCase().trim();
  const terms = phrase.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { results: features, truncated: 0 };

  const ranked = features
    .map((f) => ({ f, ...rank(f, terms, phrase) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.matchedTerms - a.matchedTerms || b.score - a.score);

  // Every term present is the useful answer; fall back to partial matches only
  // when nothing matches the whole query.
  const complete = ranked.filter((x) => x.matchedTerms === terms.length);
  const chosen = complete.length > 0 ? complete : ranked;

  return {
    results: chosen.slice(0, MAX_RESULTS).map((x) => x.f),
    truncated: Math.max(0, chosen.length - MAX_RESULTS),
  };
}

export interface FeaturesOptions {
  product: string;
  search?: string;
  /** Print everything we know about each match, not just the one-liner. */
  verbose?: boolean;
}

interface Haystack {
  weight: number;
  text: string;
}

function haystacks(feature: Feature): Haystack[] {
  return [
    { weight: 6, text: feature.name.toLowerCase() },
    { weight: 4, text: feature.aliases.join(" ").toLowerCase() },
    { weight: 2, text: feature.entities.join(" ").toLowerCase() },
    { weight: 2, text: feature.category.toLowerCase() },
    { weight: 1, text: feature.summary.toLowerCase() },
  ];
}

/**
 * Rank a feature against a query, and report how many of the query's terms it
 * matched at all.
 *
 * The term count matters more than the score: a catalog for one product area
 * shares vocabulary, so scoring term-by-term alone made "approve time off"
 * match 120 of 125 features. Requiring every term to appear somewhere is what
 * makes the result a search rather than a ranking of the whole catalog.
 */
function rank(feature: Feature, terms: string[], phrase: string) {
  const fields = haystacks(feature);
  let score = 0;
  let matchedTerms = 0;

  for (const field of fields) {
    if (field.text.includes(phrase)) score += field.weight * 3;
  }
  for (const term of terms) {
    let matched = false;
    for (const field of fields) {
      if (containsWord(field.text, term)) {
        score += field.weight;
        matched = true;
      }
    }
    if (matched) matchedTerms++;
  }
  return { score, matchedTerms };
}

const MAX_RESULTS = 25;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Match whole words, not substrings.
 *
 * Substring matching made the short words in a query do damage - "clock in"
 * ranked "Include excluded employees" highly because "in" appears inside
 * "Include". Word boundaries cost nothing and remove that whole class of
 * nonsense result.
 */
const containsWord = (haystack: string, term: string) =>
  new RegExp(`(^|[^a-z0-9])${escapeRegex(term)}([^a-z0-9]|$)`, "i").test(haystack);

export function features(options: FeaturesOptions): number {
  const product = slugify(options.product);
  const file = featureCatalogPath(product);
  const catalog = readArtifact(file, FeatureCatalogSchema);

  const found = options.search
    ? searchFeatures(catalog.features, options.search)
    : { results: catalog.features, truncated: 0 };
  const list = found.results;
  const truncated = found.truncated;

  log.blank();
  log.info(
    `${bold(catalog.product)} — ${fmtCount(list.length, "feature")}` +
      (options.search ? ` matching "${options.search}"` : "") +
      dim(`  (${rel(file)})`),
  );
  log.blank();

  let lastCategory = "";
  for (const feature of list) {
    if (!options.search && feature.category !== lastCategory) {
      lastCategory = feature.category;
      console.log(`  ${bold(feature.category)}`);
    }
    console.log(`    ${feature.name}  ${dim(feature.id)}`);
    if (options.verbose) {
      console.log(dim(`      ${feature.summary}`));
      if (feature.prerequisites.length > 0) {
        console.log(dim(`      needs: ${feature.prerequisites.join("; ")}`));
      }
      for (const [i, step] of feature.docSteps.entries()) {
        console.log(dim(`      ${i + 1}. ${step}`));
      }
      if (feature.sourceUrls[0]) console.log(dim(`      ${feature.sourceUrls[0]}`));
    }
  }

  if (truncated > 0) {
    log.detail(`  … and ${truncated} weaker ${truncated === 1 ? "match" : "matches"} not shown`);
  }
  log.blank();
  if (list.length === 0 && options.search) {
    log.info("No match. Run without --search to see the whole catalog.");
  }
  return 0;
}
