import fs from "node:fs";
import path from "node:path";
import { crawl } from "../docs/crawler.js";
import { extractPage, renderPages, type ExtractedPage } from "../docs/extract.js";
import { distill } from "../docs/distill.js";
import {
  knowledgeDir,
  pagesDir,
  docIndexPath,
  featureCatalogPath,
  ensureDir,
  rel,
} from "../paths.js";
import { readArtifact, writeArtifact, shortHash, slugify, nowIso } from "../io.js";
import { DocIndexSchema, FeatureCatalogSchema, type DocIndex } from "../types.js";
import { log, fmtCount, bold } from "../log.js";

export interface LearnOptions {
  product?: string;
  maxPages?: number;
  ignoreRobots?: boolean;
  /** Regex source; keep only URLs matching it. */
  include?: string;
  /** Follow links this many hops from the root instead of using the sitemap. */
  depth?: number;
  /** Re-crawl even if a corpus for this product already exists. */
  refresh?: boolean;
  /** Crawl only - skip the (paid) feature extraction. */
  crawlOnly?: boolean;
}

/** Default product slug from the docs host: help.factorialhr.com -> factorialhr. */
function inferProduct(rootUrl: string): string {
  const host = new URL(rootUrl).hostname;
  const parts = host.split(".").filter((p) => !["www", "help", "support", "docs", "com", "org", "io", "net", "co"].includes(p));
  return slugify(parts[0] ?? host);
}

function loadCachedCorpus(product: string): ExtractedPage[] {
  const index = readArtifact(docIndexPath(product), DocIndexSchema);
  const pages: ExtractedPage[] = [];
  for (const page of index.pages) {
    const file = path.join(pagesDir(product), page.file);
    if (!fs.existsSync(file)) continue;
    pages.push({
      url: page.url,
      title: page.title,
      markdown: fs.readFileSync(file, "utf8"),
      headings: page.headings,
      breadcrumb: page.breadcrumb,
      wordCount: page.wordCount,
    });
  }
  return pages;
}

async function crawlAndExtract(
  rootUrl: string,
  options: LearnOptions,
): Promise<ExtractedPage[]> {
  log.step(`Crawling ${rootUrl}`);
  const fetched = await crawl({
    rootUrl,
    maxPages: options.maxPages,
    ignoreRobots: options.ignoreRobots,
    ...(options.include ? { include: new RegExp(options.include) } : {}),
    ...(options.depth !== undefined ? { depth: options.depth } : {}),
  });
  log.ok(`Fetched ${fmtCount(fetched.length, "page")}`);

  const extracted: ExtractedPage[] = [];
  const needsRendering: string[] = [];
  for (const page of fetched) {
    const result = extractPage(page.url, page.html);
    if (result) extracted.push(result);
    else needsRendering.push(page.url);
  }

  // A page that yields no article from static HTML is usually client-rendered.
  // Re-fetching those through a real browser recovers Intercom/Notion-style
  // help centers that would otherwise produce an empty corpus.
  if (needsRendering.length > 0) {
    log.step(
      `Re-rendering ${fmtCount(needsRendering.length, "page")} that returned no article`,
    );
    const rendered = await renderPages(needsRendering.slice(0, 120));
    let recovered = 0;
    for (const [url, html] of rendered) {
      const result = extractPage(url, html);
      if (result) {
        extracted.push(result);
        recovered++;
      }
    }
    log.detail(`recovered ${recovered}`);
  }

  log.ok(`Extracted ${fmtCount(extracted.length, "article")}`);
  return extracted;
}

function writeCorpus(
  product: string,
  rootUrl: string,
  pages: ExtractedPage[],
): DocIndex {
  const dir = ensureDir(pagesDir(product));
  for (const existing of fs.readdirSync(dir)) {
    if (existing.endsWith(".md")) fs.unlinkSync(path.join(dir, existing));
  }

  const index = {
    product,
    rootUrl,
    crawledAt: nowIso(),
    pages: pages.map((page) => {
      const hash = shortHash(page.url);
      const file = `${hash}.md`;
      fs.writeFileSync(path.join(dir, file), page.markdown, "utf8");
      return {
        url: page.url,
        title: page.title,
        file,
        hash,
        breadcrumb: page.breadcrumb,
        headings: page.headings,
        wordCount: page.wordCount,
        fetchedAt: nowIso(),
      };
    }),
  };
  return writeArtifact(docIndexPath(product), DocIndexSchema, index);
}

export async function learn(rootUrl: string, options: LearnOptions): Promise<number> {
  const product = options.product ? slugify(options.product) : inferProduct(rootUrl);
  log.blank();
  log.info(`${bold("product")} ${product}`);

  const haveCorpus = fs.existsSync(docIndexPath(product));
  let pages: ExtractedPage[];

  if (haveCorpus && !options.refresh) {
    pages = loadCachedCorpus(product);
    log.ok(
      `Reusing ${fmtCount(pages.length, "page")} already crawled ` +
        `(${rel(knowledgeDir(product))}). Pass --refresh to re-crawl.`,
    );
  } else {
    pages = await crawlAndExtract(rootUrl, options);
    if (pages.length === 0) {
      log.error(
        "Nothing extractable was found. Check the root URL, or raise --max-pages.",
      );
      return 1;
    }
    writeCorpus(product, rootUrl, pages);
    log.ok(`Corpus written to ${rel(pagesDir(product))}`);
  }

  if (options.crawlOnly) {
    log.blank();
    log.info("Stopping before feature extraction (--crawl-only).");
    return 0;
  }

  const catalog = await distill(product, rootUrl, pages);
  writeArtifact(featureCatalogPath(product), FeatureCatalogSchema, catalog);

  log.blank();
  log.ok(
    `${fmtCount(catalog.features.length, "feature")} catalogued → ` +
      rel(featureCatalogPath(product)),
  );
  const categories = [...new Set(catalog.features.map((f) => f.category))].sort();
  log.detail(categories.join(" · "));
  log.blank();
  log.info(`Next: vdg connect <app-url> --product ${product} --profile demo`);
  log.blank();
  return 0;
}
