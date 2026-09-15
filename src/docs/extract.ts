import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { config } from "../config.js";
import { launch, newContext } from "../browser.js";

export interface ExtractedPage {
  url: string;
  title: string;
  markdown: string;
  headings: string[];
  breadcrumb: string[];
  wordCount: number;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
// Navigation chrome adds noise and tokens without describing the product.
turndown.remove(["script", "style", "nav", "footer", "form", "noscript"]);

/** jsdom is noisy about CSS it cannot parse; none of it matters to us. */
function quietDom(html: string, url: string): JSDOM {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("error", () => {});
  virtualConsole.on("warn", () => {});
  virtualConsole.on("jsdomError", () => {});
  return new JSDOM(html, { url, virtualConsole });
}

function readBreadcrumb(doc: Document): string[] {
  const selectors = [
    'nav[aria-label*="readcrumb" i]',
    '[class*="breadcrumb" i]',
    '[data-testid*="breadcrumb" i]',
  ];
  for (const selector of selectors) {
    const node = doc.querySelector(selector);
    if (!node) continue;
    const parts = [...node.querySelectorAll("a, li, span")]
      .map((el) => (el.textContent ?? "").trim())
      .filter((t) => t.length > 0 && t.length < 80);
    const unique = [...new Set(parts)];
    if (unique.length > 0) return unique.slice(0, 6);
  }
  return [];
}

/**
 * The article's own title, as a person would say it.
 *
 * Two traps, both seen on real help centers: templates often open with an empty
 * or decorative `<h1>` before the real one, so the *first* h1 is the wrong
 * answer; and the `<title>` pairs the article with the brand in either order
 * ("Factorial - How to X" as often as "How to X | Factorial"), so stripping a
 * fixed side is wrong half the time. Taking the longest segment gets both,
 * because the brand is essentially never the longer half.
 */
function bestTitle(doc: Document, readabilityTitle: string | null): string {
  const candidates = doc.querySelectorAll(
    "h1.question_title, [class*='title' i] h1, main h1, article h1, h1",
  );
  for (const node of candidates) {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length > 2 && text.length < 140) return text;
  }

  const fallback = (readabilityTitle ?? doc.title ?? "").replace(/\s+/g, " ").trim();
  const segments = fallback
    .split(/\s+[\u00b7|\u2013\u2014-]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (segments.length === 0) return fallback;
  return segments.reduce((longest, part) =>
    part.length > longest.length ? part : longest,
  );
}

function headingsFromMarkdown(markdown: string): string[] {
  return [...markdown.matchAll(/^#{1,4}\s+(.+)$/gm)]
    .map((m) => m[1]!.trim())
    .filter(Boolean)
    .slice(0, 40);
}

const countWords = (s: string) => (s.match(/\S+/g) ?? []).length;

/**
 * Readability strips the site chrome and leaves the article. It fails on pages
 * that are pure navigation (category listings), which is the right outcome -
 * those carry no product knowledge worth paying tokens for.
 */
export function extractPage(url: string, html: string): ExtractedPage | null {
  const dom = quietDom(html, url);
  const doc = dom.window.document;
  const breadcrumb = readBreadcrumb(doc);

  const article = new Readability(doc.cloneNode(true) as Document).parse();
  const title = bestTitle(doc, article?.title ?? null);
  const contentHtml = article?.content ?? doc.querySelector("main")?.innerHTML ?? "";
  if (!contentHtml) {
    dom.window.close();
    return null;
  }

  const markdown = turndown
    .turndown(contentHtml)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const wordCount = countWords(markdown);
  dom.window.close();

  if (wordCount < 25) return null;

  return {
    url,
    title: title || url,
    markdown,
    headings: headingsFromMarkdown(markdown),
    breadcrumb,
    wordCount,
  };
}

/**
 * Fallback for help centers that render articles client-side (Intercom,
 * Notion-backed sites): a plain fetch returns an empty shell, so run a real
 * browser and take the settled DOM.
 */
export async function renderPages(urls: string[]): Promise<Map<string, string>> {
  const rendered = new Map<string, string>();
  if (urls.length === 0) return rendered;

  const browser = await launch(true);
  try {
    const context = await newContext(browser, {
      userAgent: config.crawl.userAgent,
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
        rendered.set(url, await page.content());
      } catch {
        // A page that will not render is simply left out of the corpus.
      }
    }
    await context.close();
  } finally {
    await browser.close();
  }
  return rendered;
}

/**
 * The links a *reader* sees on a page.
 *
 * Some help-center templates ship the entire site index in every category
 * page's HTML and scope it with CSS - the Factorial category pages carry 720
 * links of which 47 are on screen. Following raw hrefs there would crawl the
 * whole site, so link discovery has to go through a browser and take only what
 * is actually visible.
 */
export async function visibleLinks(urls: string[]): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  if (urls.length === 0) return found;

  const browser = await launch(true);
  try {
    const context = await newContext(browser, {
      userAgent: config.crawl.userAgent,
      viewport: { width: 1400, height: 1000 },
    });
    const page = await context.newPage();
    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
        found.set(
          url,
          await page.evaluate(() => {
            const out: string[] = [];
            for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
              const rect = anchor.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              const style = window.getComputedStyle(anchor);
              if (style.visibility === "hidden" || style.display === "none") continue;
              if (anchor.closest("[aria-hidden='true']")) continue;
              out.push(anchor.href);
            }
            return out;
          }),
        );
      } catch {
        found.set(url, []);
      }
    }
    await context.close();
  } finally {
    await browser.close();
  }
  return found;
}
