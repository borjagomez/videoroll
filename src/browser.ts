import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import { config } from "./config.js";

/**
 * esbuild - which tsx runs - rewrites function-valued locals into
 * `__name(fn, "fn")` calls to preserve `Function.name`. That helper is injected
 * into the *module*, not into the page, so any `page.evaluate` body containing
 * a named inner function dies with "__name is not defined".
 *
 * Defining a no-op `__name` in every page context makes evaluate bodies behave
 * like ordinary TypeScript. It is passed as a raw string so the bundler never
 * sees it. Harmless in production builds, where the helper is absent.
 */
const ESBUILD_NAME_SHIM = "globalThis.__name ||= (fn) => fn;";

export interface ContextOptions extends BrowserContextOptions {
  /** Load a session saved by `vdg connect`. */
  storageStatePath?: string;
}

export async function newContext(
  browser: Browser,
  options: ContextOptions = {},
): Promise<BrowserContext> {
  const { storageStatePath, ...rest } = options;
  const context = await browser.newContext({
    viewport: { width: config.video.width, height: config.video.height },
    ...(storageStatePath ? { storageState: storageStatePath } : {}),
    ...rest,
  });
  await context.addInitScript({ content: ESBUILD_NAME_SHIM });
  return context;
}

export async function launch(headless = true): Promise<Browser> {
  const { chromium } = await import("playwright");
  return chromium.launch({
    headless,
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

/**
 * Wait until the page has actually drawn something and stopped changing.
 *
 * `networkidle` is not enough for a single-page app that keeps polling: on
 * Factorial the dashboard is still blank at 1.5s and only fills in around 4s,
 * so anything that reads the DOM too early sees an empty screen and concludes
 * the page has no content. This waits for the rendered text to stop growing,
 * which is the signal that actually correlates with "ready".
 */
export async function settle(
  page: Page,
  options: { minMs?: number; maxMs?: number } = {},
): Promise<void> {
  const minMs = options.minMs ?? 600;
  const maxMs = options.maxMs ?? 12_000;
  const deadline = Date.now() + maxMs;

  await page.waitForTimeout(minMs);
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);

  let previous = -1;
  let stableRounds = 0;
  while (Date.now() < deadline) {
    // Measure the content region, not the whole document. The chrome - sidebar,
    // top bar - renders first and then sits still, so whole-page text length
    // goes stable while the list you actually care about is still loading. On
    // Factorial's inbox that meant reporting an empty screen while twelve
    // pending approvals were seconds away.
    const size = await page
      .evaluate(() => {
        const main = document.querySelector("main");
        const scope = main && (main.innerText ?? "").trim().length > 0 ? main : document.body;
        return (scope.innerText ?? "").length;
      })
      .catch(() => -1);

    if (size > 0 && size === previous) {
      // Three readings rather than two: a lazily-loaded list often pauses
      // briefly between the shell appearing and its rows arriving.
      if (++stableRounds >= 3) return;
    } else {
      stableRounds = 0;
    }
    previous = size;
    await page.waitForTimeout(500);
  }
}

/**
 * Wait only until the app has drawn *something*.
 *
 * Weaker than `settle`, and deliberately so. Before the first filmed step we
 * need the screen not to be blank; we do not need it to have stopped changing.
 * Waiting for full stability costs about ten seconds on a heavy screen, which
 * is fine for reading a page but absurd as an intro length.
 */
export async function waitForContent(page: Page, timeoutMs = 15_000): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const main = document.querySelector("main");
        const text = ((main ?? document.body)?.innerText ?? "").trim();
        return text.length > 60;
      },
      undefined,
      { timeout: timeoutMs, polling: 250 },
    )
    .catch(() => undefined);
}
