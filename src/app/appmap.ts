import type { Page } from "playwright";
import { settle } from "../browser.js";
import { nowIso } from "../io.js";
import { log, fmtCount } from "../log.js";
import type { AppMap, AppRoute } from "../types.js";

/**
 * Reads the product's own navigation.
 *
 * This is the scout's head start: instead of hunting for where "Time off"
 * lives, it begins already knowing the sidebar has that item and where it
 * points.
 *
 * Page contexts come from src/browser.ts, which installs a `__name` shim -
 * read the comment there before writing an `evaluate` body.
 */
async function readNav(page: Page): Promise<AppRoute[]> {
  return page.evaluate(() => {
    const CONTAINERS = [
      "nav",
      "[role='navigation']",
      "aside",
      "header",
      "[class*='sidebar' i]",
      "[class*='side-nav' i]",
      "[class*='menu' i]",
      "[data-testid*='nav' i]",
    ];

    const seen = new Set<string>();
    const routes: Array<{
      label: string;
      url?: string;
      kind: "link" | "button";
      section?: string;
    }> = [];

    for (const selector of CONTAINERS) {
      for (const container of document.querySelectorAll(selector)) {
        const sectionLabel = (
          container.getAttribute("aria-label") ??
          container.querySelector("h1, h2, h3, .brand")?.textContent ??
          ""
        ).trim();
        const section =
          sectionLabel && sectionLabel.length < 40 ? sectionLabel : undefined;

        for (const el of container.querySelectorAll<HTMLElement>(
          "a[href], button, [role='menuitem'], [role='tab']",
        )) {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (rect.width === 0 && rect.height === 0) continue;
          if (style.visibility === "hidden" || style.display === "none") continue;

          const label = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          if (!label || label.length > 48) continue;

          const href = el.getAttribute("href");
          const url =
            href && !href.startsWith("javascript:")
              ? new URL(href, document.baseURI).toString()
              : undefined;

          const key = label + "|" + (url ?? "");
          if (seen.has(key)) continue;
          seen.add(key);

          routes.push({
            label,
            url,
            kind: el.tagName === "A" && url ? "link" : "button",
            section,
          });
        }
      }
    }
    return routes;
  });
}

export interface AppMapOptions {
  profile: string;
  product: string;
  baseUrl: string;
  /** Visit each route and record what is actually on that screen. */
  deep?: boolean;
  maxDeepRoutes?: number;
}

/** What a route's screen contains - headings and the actions offered there. */
async function describeRoute(page: Page, route: AppRoute): Promise<string | undefined> {
  if (!route.url) return undefined;
  try {
    const before = page.url();
    await page.goto(route.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    // A goto that only changes the fragment does not re-render a hash-routed
    // SPA, so every screen would describe whichever view happened to be open.
    // A reload makes the app read location.hash from scratch.
    if (before.split("#")[0] === route.url.split("#")[0] && route.url.includes("#")) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
    }
    await settle(page);

    const summary = await page.evaluate(() => {
      // Scope to <main> where it exists: that excludes the sidebar and top bar,
      // whose labels are the same on every screen and describe nothing.
      const scope = document.querySelector("main") ?? document.body;
      const visible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const headings: string[] = [];
      for (const el of scope.querySelectorAll("h1, h2, h3, [role='heading']")) {
        if (!visible(el)) continue;
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text && text.length < 90) headings.push(text);
      }

      const actions: string[] = [];
      for (const el of scope.querySelectorAll(
        "button, a[role='button'], [type='submit'], [role='tab']",
      )) {
        if (!visible(el)) continue;
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text && text.length < 32) actions.push(text);
      }

      return {
        heading: headings[0],
        actions: [...new Set(actions)].slice(0, 8),
      };
    });

    const parts = [
      summary.heading,
      summary.actions.length > 0 ? `actions: ${summary.actions.join(", ")}` : "",
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" — ") : undefined;
  } catch {
    return undefined;
  }
}

export async function buildAppMap(page: Page, options: AppMapOptions): Promise<AppMap> {
  log.step("Reading the app's navigation");
  const routes = await readNav(page);
  log.detail(`${fmtCount(routes.length, "nav item")}`);

  if (options.deep) {
    const linkRoutes = routes.filter((r) => r.url);
    const budget = Math.min(linkRoutes.length, options.maxDeepRoutes ?? 20);
    log.step(`Visiting ${fmtCount(budget, "screen")} to see what is on them`);
    for (const route of linkRoutes.slice(0, budget)) {
      route.description = await describeRoute(page, route);
    }
  }

  return {
    profile: options.profile,
    product: options.product,
    baseUrl: options.baseUrl,
    capturedAt: nowIso(),
    routes,
  };
}
