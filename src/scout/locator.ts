import type { Page, Locator as PwLocator } from "playwright";
import type { Locator } from "../types.js";

/**
 * Turn a stored locator into a live Playwright locator. The single place that
 * knows how each `kind` maps onto Playwright, so the scout (which verifies)
 * and the recorder (which replays) can never drift apart.
 */
export function resolve(page: Page, locator: Locator): PwLocator {
  let found: PwLocator;
  switch (locator.kind) {
    case "role":
      found = page.getByRole(locator.role as Parameters<Page["getByRole"]>[0], {
        ...(locator.name ? { name: locator.name } : {}),
        ...(locator.exact !== undefined ? { exact: locator.exact } : {}),
      });
      break;
    case "label":
      found = page.getByLabel(locator.name, { exact: locator.exact ?? true });
      break;
    case "placeholder":
      found = page.getByPlaceholder(locator.name, { exact: locator.exact ?? true });
      break;
    case "text":
      found = page.getByText(locator.name, { exact: locator.exact ?? true });
      break;
    case "testid":
      found = page.getByTestId(locator.value);
      break;
    case "css":
      found = page.locator(locator.selector);
      break;
  }
  return locator.nth !== undefined ? found.nth(locator.nth) : found;
}

/** Human-readable form, used in logs, errors and the steps.json summary. */
export function describe(locator: Locator): string {
  const suffix = locator.nth !== undefined ? ` #${locator.nth}` : "";
  switch (locator.kind) {
    case "role":
      return `${locator.role}${locator.name ? ` "${locator.name}"` : ""}${suffix}`;
    case "label":
      return `field labelled "${locator.name}"${suffix}`;
    case "placeholder":
      return `field placeholder "${locator.name}"${suffix}`;
    case "text":
      return `text "${locator.name}"${suffix}`;
    case "testid":
      return `testid ${locator.value}${suffix}`;
    case "css":
      return `css ${locator.selector}${suffix}`;
  }
}
