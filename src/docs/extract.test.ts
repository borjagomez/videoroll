import { describe, it, expect } from "vitest";
import { extractPage } from "./extract.js";

const URL = "https://help.example.com/en_US/time-tracking/how-to-approve";

function pageWith(head: string, body: string): string {
  return `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
}

/** Enough prose to clear the "is this an article" word-count floor. */
const PROSE = `
  <p>Managers review their team's timesheets from the Time tracking section.
  Approving a timesheet locks the hours for that period and passes them to
  payroll, so it should be done once the month is closed.</p>
  <h2>Steps</h2>
  <ol>
    <li>In the left sidebar, click Time tracking.</li>
    <li>Open the Timesheets tab and pick the period you want to review.</li>
    <li>Check the hours for each employee against their contract.</li>
    <li>Click Approve to confirm the period.</li>
  </ol>
  <p>The period's status changes to Approved and the hours are sent onward.</p>
`;

describe("extractPage titles", () => {
  it("skips a decorative empty h1 and takes the real article heading", () => {
    // The shape that broke a real crawl: every page came back titled "Factorial".
    const html = pageWith(
      "<title>Factorial &mdash; How to approve timesheets</title>",
      `<header><h1></h1></header>
       <main><h1 class="question_title">How to approve timesheets</h1>${PROSE}</main>`,
    );
    expect(extractPage(URL, html)?.title).toBe("How to approve timesheets");
  });

  it("takes the article half when the brand comes first in the title tag", () => {
    const html = pageWith(
      "<title>Factorial &mdash; How to approve timesheets</title>",
      `<main>${PROSE}</main>`,
    );
    expect(extractPage(URL, html)?.title).toBe("How to approve timesheets");
  });

  it("takes the article half when the brand comes last", () => {
    const html = pageWith(
      "<title>How to approve timesheets | Factorial Help</title>",
      `<main>${PROSE}</main>`,
    );
    expect(extractPage(URL, html)?.title).toBe("How to approve timesheets");
  });

  it("leaves a title with no brand separator alone", () => {
    const html = pageWith(
      "<title>How to approve timesheets</title>",
      `<main>${PROSE}</main>`,
    );
    expect(extractPage(URL, html)?.title).toBe("How to approve timesheets");
  });

  it("ignores an h1 that is only branding when a longer heading follows", () => {
    const html = pageWith(
      "<title>Help</title>",
      `<main><h1 class="brand-title">A</h1><h1>How to approve timesheets</h1>${PROSE}</main>`,
    );
    expect(extractPage(URL, html)?.title).toBe("How to approve timesheets");
  });
});

describe("extractPage content", () => {
  it("converts the article to markdown and counts its words", () => {
    const page = extractPage(
      URL,
      pageWith("<title>How to approve</title>", `<main><h1>How to approve</h1>${PROSE}</main>`),
    );
    expect(page).not.toBeNull();
    expect(page!.markdown).toContain("In the left sidebar, click Time tracking.");
    expect(page!.headings).toContain("Steps");
    expect(page!.wordCount).toBeGreaterThan(40);
  });

  it("returns null for a page with no article in it", () => {
    const html = pageWith(
      "<title>Categories</title>",
      `<nav><a href="/a">Time tracking</a><a href="/b">Absences</a></nav>`,
    );
    expect(extractPage(URL, html)).toBeNull();
  });

  it("reads a breadcrumb when the template has one", () => {
    const html = pageWith(
      "<title>How to approve</title>",
      `<nav aria-label="Breadcrumb"><a href="/">Help center</a><a href="/tt">Time tracking</a></nav>
       <main><h1>How to approve</h1>${PROSE}</main>`,
    );
    expect(extractPage(URL, html)?.breadcrumb).toContain("Time tracking");
  });
});
