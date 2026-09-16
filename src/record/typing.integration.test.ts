import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, Page } from "playwright";
import { launch, newContext } from "../browser.js";
import { typeInto } from "./typing.js";

/**
 * The masked-field bug, pinned down.
 *
 * A demo of "configure special hours" died here: the scout typed "02:00" into
 * a time field, the mask ate the separator, the field stayed invalid and the
 * wizard never advanced - so the scout burned every iteration and recorded no
 * step at all. Only a real browser shows this; the mask lives in the widget.
 */

let browser: Browser;
let page: Page;

/** A custom mask of the kind an HR product ships: digits in, separator drawn. */
const MASKED_WIDGET = `
  <input id="masked" placeholder="--:--">
  <script>
    const field = document.getElementById("masked");
    field.addEventListener("keydown", (event) => {
      if (event.key.length !== 1) return;
      event.preventDefault();
      if (!/[0-9]/.test(event.key)) return;      // a typed ":" is dropped
      const digits = (field.value.replace(/\\D/g, "") + event.key).slice(0, 4);
      field.value =
        digits.length > 2 ? digits.slice(0, 2) + ":" + digits.slice(2) : digits;
    });
  </script>
`;

beforeAll(async () => {
  browser = await launch(true);
  const context = await newContext(browser, { viewport: { width: 800, height: 400 } });
  page = await context.newPage();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

describe("typeInto", () => {
  it("fills a native time input that character-by-character typing cannot", async () => {
    await page.setContent(`<input id="t" type="time">`);

    // What the code used to do, kept here so the regression is legible.
    const field = page.locator("#t");
    await field.click();
    await field.fill("");
    await field.pressSequentially("02:00", { delay: 5 });
    expect(await field.inputValue()).toBe("");

    await page.setContent(`<input id="t" type="time">`);
    await typeInto(page.locator("#t"), "02:00", { cinematic: true });
    expect(await page.locator("#t").inputValue()).toBe("02:00");
  });

  it("gives a masked widget its digits, and lets the mask draw the separator", async () => {
    await page.setContent(MASKED_WIDGET);
    await typeInto(page.locator("#masked"), "18:00", { cinematic: true });
    expect(await page.locator("#masked").inputValue()).toBe("18:00");
  });

  it("types an ordinary field literally, separators and all", async () => {
    await page.setContent(`<input id="x" type="text" placeholder="Name">`);
    await typeInto(page.locator("#x"), "Turnos nocturnos 9:30", { cinematic: true });
    expect(await page.locator("#x").inputValue()).toBe("Turnos nocturnos 9:30");
  });

  it("replaces what is already there rather than appending", async () => {
    await page.setContent(`<input id="x" type="text" value="Old name">`);
    await typeInto(page.locator("#x"), "New name", { cinematic: true });
    expect(await page.locator("#x").inputValue()).toBe("New name");
  });

  it("sets the value in one go when nobody is watching", async () => {
    await page.setContent(`<input id="t" type="time">`);
    await typeInto(page.locator("#t"), "23:45", {});
    expect(await page.locator("#t").inputValue()).toBe("23:45");
  });
});
