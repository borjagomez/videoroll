import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { Browser, Page } from "playwright";
import { launch, newContext } from "../browser.js";
import { captureSnapshot, deriveLocator } from "./snapshot.js";
import { resolve } from "./locator.js";
import { projectRoot } from "../paths.js";

/**
 * Exercises the perception layer against the real DOM of the fixture app.
 *
 * The unit tests cover locator *policy* on synthetic input; this covers the
 * part that can only break against a browser - accessible names, implicit
 * roles, visibility, and whether a derived locator actually finds the element
 * it was derived from.
 */

const APP_DIR = path.join(projectRoot, "fixtures", "app");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

let server: http.Server;
let browser: Browser;
let page: Page;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const file = path.join(APP_DIR, decodeURIComponent(url.pathname));
    if (!file.startsWith(APP_DIR) || !fs.existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "text/plain" });
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(0, done));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://localhost:${address.port}`;

  browser = await launch(true);
  const context = await newContext(browser, { viewport: { width: 1280, height: 900 } });
  // Skip the login form; this suite is about reading screens, not signing in.
  await context.addInitScript({
    content: `localStorage.setItem("acme.session", JSON.stringify({ email: "t@t.test" }));`,
  });
  page = await context.newPage();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.close(() => done()));
});

describe("captureSnapshot", () => {
  it("reads roles and accessible names off a real page", async () => {
    await page.goto(`${baseUrl}/app.html`);
    const snapshot = await captureSnapshot(page);

    const timeOff = snapshot.elements.find((e) => e.name === "Time off");
    expect(timeOff).toBeDefined();
    expect(timeOff!.role).toBe("link");
    expect(timeOff!.unique.roleName).toBe(true);
  });

  it("gives every element a distinct ref", async () => {
    await page.goto(`${baseUrl}/app.html`);
    await page.getByRole("link", { name: "Time off", exact: true }).click();
    const snapshot = await captureSnapshot(page);

    // Five nav links plus the per-row Approve/Reject buttons.
    expect(snapshot.elements.length).toBeGreaterThan(8);
    expect(new Set(snapshot.elements.map((e) => e.ref)).size).toBe(
      snapshot.elements.length,
    );
  });

  it("notices when a name repeats and indexes the duplicates", async () => {
    await page.goto(`${baseUrl}/app.html`);
    await page.getByRole("link", { name: "Time off", exact: true }).click();
    const snapshot = await captureSnapshot(page);

    const approves = snapshot.elements.filter((e) => e.name === "Approve");
    expect(approves.length).toBe(3);
    for (const approve of approves) expect(approve.unique.roleName).toBe(false);
    expect(approves.map((e) => e.roleNameIndex)).toEqual([0, 1, 2]);
  });

  it("derives a locator that finds the same element again", async () => {
    await page.goto(`${baseUrl}/app.html`);
    await page.getByRole("link", { name: "Time off", exact: true }).click();
    const snapshot = await captureSnapshot(page);

    const second = snapshot.elements.filter((e) => e.name === "Approve")[1]!;
    const locator = resolve(page, deriveLocator(second));
    expect(await locator.count()).toBe(1);
    // Row two is Reza's; proves the index landed on the right row.
    const rowText = await locator.locator("xpath=ancestor::tr").innerText();
    expect(rowText).toContain("Reza Ahmadi");
  });

  it("carries row context so a repeated button can be told apart", async () => {
    await page.goto(`${baseUrl}/app.html`);
    await page.getByRole("link", { name: "Time off", exact: true }).click();
    const snapshot = await captureSnapshot(page);

    const first = snapshot.elements.find((e) => e.name === "Approve")!;
    expect(first.context).toContain("Dana Wu");
  });

  it("reports only what is visible", async () => {
    await page.goto(`${baseUrl}/app.html`);
    const snapshot = await captureSnapshot(page);
    // Expenses lives in a hidden section until its nav item is clicked.
    expect(snapshot.elements.some((e) => e.name === "New expense")).toBe(false);

    await page.getByRole("link", { name: "Expenses", exact: true }).click();
    const after = await captureSnapshot(page);
    expect(after.elements.some((e) => e.name === "New expense")).toBe(true);
  });

  it("picks up a field's label and a dialog's contents once open", async () => {
    await page.goto(`${baseUrl}/app.html`);
    await page.getByRole("link", { name: "Time off", exact: true }).click();
    await page.getByRole("button", { name: "Approve", exact: true }).first().click();
    const snapshot = await captureSnapshot(page);

    const note = snapshot.elements.find((e) => e.tag === "textarea");
    expect(note).toBeDefined();
    expect(note!.labelText).toContain("Note for the employee");

    // A labelled field takes its accessible name from that label, so the
    // strongest locator is still role+name - and it must resolve uniquely.
    const locator = deriveLocator(note!);
    expect(locator).toMatchObject({ kind: "role", role: "textbox" });
    expect(await resolve(page, locator).count()).toBe(1);

    expect(snapshot.elements.some((e) => e.name === "Confirm approval")).toBe(true);
  });

  it("does not fold a select's options into its label", async () => {
    await page.goto(`${baseUrl}/app.html`);
    await page.getByRole("link", { name: "Expenses", exact: true }).click();
    await page.getByRole("button", { name: "New expense", exact: true }).click();
    const snapshot = await captureSnapshot(page);

    const category = snapshot.elements.find((e) => e.tag === "select")!;
    expect(category).toBeDefined();

    // The bug this guards: a <select> wrapped in its <label> took the label's
    // whole textContent as its name - "CategoryTravelMealsSoftware" - giving a
    // locator that breaks the moment an option is added, and that failed to
    // match at all when options loaded late.
    expect(category.labelText).toBe("Category");
    expect(category.name).not.toContain("Travel");

    const locator = deriveLocator(category);
    expect(locator).toMatchObject({ kind: "role", role: "combobox" });
    expect(await resolve(page, locator).count()).toBe(1);
  });

  it("renders a snapshot the model can read", async () => {
    await page.goto(`${baseUrl}/app.html`);
    const snapshot = await captureSnapshot(page);
    expect(snapshot.text).toContain("interactive elements:");
    expect(snapshot.text).toContain('link "Time off"');
    expect(snapshot.text).toMatch(/^url: http/m);
  });
});
