import pLimit from "p-limit";
import robotsParserModule from "robots-parser";
import { config } from "../config.js";
import { log, dim } from "../log.js";

/** A page as fetched, before extraction. */
export interface FetchedPage {
  url: string;
  html: string;
}

/**
 * robots-parser is CommonJS (`module.exports = fn`) and its .d.ts opens with an
 * empty `declare module`, which hides the call signature under NodeNext. The
 * default import is the function at runtime - verified - so retype it here.
 */
interface RobotsRules {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
}
const robotsParser = robotsParserModule as unknown as (
  url: string,
  robotsTxt: string,
) => RobotsRules;

const SKIP_EXTENSIONS =
  /\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|tgz|mp4|webm|mp3|wav|css|js|json|xml|rss|atom|woff2?|ttf|eot)$/i;

/**
 * Canonical form used for dedup. Two URLs that differ only by a trailing
 * slash, a fragment, or tracking params are the same page - crawling both
 * wastes fetches and doubles the corpus we later pay to read.
 */
export function normalizeUrl(input: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(input, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|ref$)/i.test(key)) {
      u.searchParams.delete(key);
    }
  }
  u.searchParams.sort();
  u.hostname = u.hostname.toLowerCase();
  // `/docs/index.html` and `/docs/` are the same page; collapse them or the
  // home page gets crawled twice - once from the sitemap, once as the root.
  u.pathname = u.pathname.replace(/\/index\.html?$/i, "/");
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }
  return u.toString();
}

/** In scope = same origin, and at or below the root's path. */
function inScope(url: string, root: URL): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.origin !== root.origin) return false;
  if (SKIP_EXTENSIONS.test(u.pathname)) return false;
  const rootPath = root.pathname.replace(/\/+$/, "");
  return rootPath === "" || u.pathname === rootPath || u.pathname.startsWith(rootPath + "/");
}

async function get(url: string, accept: string): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": config.crawl.userAgent, accept },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

async function loadRobots(root: URL) {
  const robotsUrl = new URL("/robots.txt", root.origin).toString();
  const res = await get(robotsUrl, "text/plain");
  const body = res ? await res.text() : "";
  return robotsParser(robotsUrl, body);
}

/** Sitemaps, including nested sitemap-index files. */
async function readSitemaps(root: URL, seen = new Set<string>()): Promise<string[]> {
  const candidates = [
    new URL("/sitemap.xml", root.origin).toString(),
    new URL("/sitemap_index.xml", root.origin).toString(),
    new URL("sitemap.xml", root).toString(),
  ];
  const found: string[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const res = await get(candidate, "application/xml");
    if (!res) continue;
    const xml = await res.text();

    const isIndex = /<sitemapindex/i.test(xml);
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!);

    if (isIndex) {
      for (const child of locs.slice(0, 50)) {
        if (seen.has(child)) continue;
        seen.add(child);
        const childRes = await get(child, "application/xml");
        if (!childRes) continue;
        const childXml = await childRes.text();
        for (const m of childXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
          found.push(m[1]!);
        }
      }
    } else {
      found.push(...locs);
    }
  }
  return found;
}

function extractLinks(html: string, base: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["']/gi)) {
    const normalized = normalizeUrl(m[1]!, base);
    if (normalized) out.push(normalized);
  }
  return out;
}

export interface CrawlOptions {
  rootUrl: string;
  maxPages?: number;
  concurrency?: number;
  /** Ignore robots.txt. Only for a site you own. */
  ignoreRobots?: boolean;
  /**
   * Keep only URLs matching this pattern. A help center is one site holding
   * every product area, so scoping to the sections you actually want to demo
   * is the difference between reading 40 pages and reading 7,000.
   */
  include?: RegExp;
  /**
   * Follow links this many hops from the root instead of using the sitemap.
   * Depth 1 is "this page and what it links to". Link discovery renders each
   * page it expands, so it sees what a reader sees.
   */
  depth?: number;
}

async function fetchPage(url: string): Promise<FetchedPage | null> {
  const res = await get(url, "text/html");
  if (!res) return null;
  if (!(res.headers.get("content-type") ?? "").includes("html")) return null;
  return { url, html: await res.text() };
}

/**
 * Walk outward from one page by a fixed number of hops.
 *
 * Scope here is the hop count, not the URL path: a category page's children
 * commonly live under sibling paths (`/time-tracking-absences` links to
 * `/time-tracking/...`), so a path-prefix rule would reject exactly the pages
 * being asked for. Discovery renders each page it expands - see `visibleLinks`.
 */
async function crawlByDepth(
  root: URL,
  options: CrawlOptions,
  allowed: (url: string) => boolean,
  maxPages: number,
): Promise<FetchedPage[]> {
  const { visibleLinks } = await import("./extract.js");
  const include = options.include;
  const depth = Math.max(0, options.depth ?? 1);
  const limit = pLimit(options.concurrency ?? config.crawl.concurrency);

  const wanted = (url: string) => {
    try {
      return new URL(url).origin === root.origin && (!include || include.test(url));
    } catch {
      return false;
    }
  };

  const seen = new Set<string>();
  const pages: FetchedPage[] = [];
  let level = [normalizeUrl(options.rootUrl)!];
  seen.add(level[0]!);

  for (let hop = 0; hop <= depth && level.length > 0 && pages.length < maxPages; hop++) {
    const room = maxPages - pages.length;
    const batch = level.slice(0, room);

    const fetched = await Promise.all(
      batch.map((url) => limit(() => (allowed(url) ? fetchPage(url) : null))),
    );
    for (const page of fetched) if (page) pages.push(page);
    log.detail(dim(`hop ${hop}: ${pages.length} pages`));

    if (hop === depth) break;

    log.detail(`expanding ${batch.length} page(s) in a browser to read their links`);
    const rendered = await visibleLinks(batch);
    const next: string[] = [];
    for (const links of rendered.values()) {
      for (const raw of links) {
        const url = normalizeUrl(raw);
        if (!url || seen.has(url) || !wanted(url)) continue;
        seen.add(url);
        next.push(url);
      }
    }
    level = next;
  }

  return pages;
}

/**
 * Sitemap first, BFS as the fallback. Most help centers publish a sitemap, and
 * using it means we fetch each article exactly once instead of re-walking
 * category pages to discover them.
 */
export async function crawl(options: CrawlOptions): Promise<FetchedPage[]> {
  const root = new URL(options.rootUrl);
  const maxPages = options.maxPages ?? config.crawl.maxPages;
  const limit = pLimit(options.concurrency ?? config.crawl.concurrency);

  const robots = options.ignoreRobots ? null : await loadRobots(root);
  const allowed = (url: string) =>
    !robots || robots.isAllowed(url, config.crawl.userAgent) !== false;

  if (options.depth !== undefined) {
    return crawlByDepth(root, options, allowed, maxPages);
  }

  const include = options.include;
  const wanted = (url: string) => inScope(url, root) && (!include || include.test(url));

  const rootNormalized = normalizeUrl(options.rootUrl)!;
  const queue: string[] = [rootNormalized];
  const queued = new Set<string>([rootNormalized]);

  const sitemapUrls = await readSitemaps(root);
  let fromSitemap = 0;
  for (const raw of sitemapUrls) {
    const url = normalizeUrl(raw);
    if (!url || queued.has(url) || !wanted(url)) continue;
    queued.add(url);
    queue.push(url);
    fromSitemap++;
  }
  log.detail(
    fromSitemap > 0
      ? `sitemap: ${fromSitemap} in-scope URLs` +
          (include ? ` matching ${include.source}` : "")
      : "no usable sitemap - falling back to link crawl",
  );

  const pages: FetchedPage[] = [];
  const visited = new Set<string>();
  let skippedByRobots = 0;

  while (queue.length > 0 && pages.length < maxPages) {
    const batch = queue.splice(0, Math.min(queue.length, maxPages - pages.length));
    const results = await Promise.all(
      batch.map((url) =>
        limit(async (): Promise<{ page: FetchedPage; links: string[] } | null> => {
          if (visited.has(url)) return null;
          visited.add(url);
          if (!allowed(url)) {
            skippedByRobots++;
            return null;
          }
          const res = await get(url, "text/html");
          if (!res) return null;
          const type = res.headers.get("content-type") ?? "";
          if (!type.includes("html")) return null;
          const html = await res.text();
          return { page: { url, html }, links: extractLinks(html, url) };
        }),
      ),
    );

    for (const result of results) {
      if (!result) continue;
      pages.push(result.page);
      // Only expand the frontier when the sitemap did not already give us one.
      if (fromSitemap === 0) {
        for (const link of result.links) {
          if (queued.has(link) || !wanted(link)) continue;
          queued.add(link);
          queue.push(link);
        }
      }
    }
    log.detail(dim(`fetched ${pages.length}/${Math.min(maxPages, queued.size)}`));
  }

  if (skippedByRobots > 0) {
    log.warn(`${skippedByRobots} URLs skipped by robots.txt`);
  }
  return pages;
}
