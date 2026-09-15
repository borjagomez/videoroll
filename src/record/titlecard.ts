import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { projectRoot } from "../paths.js";
import { config } from "../config.js";

/**
 * A branded card that covers the first seconds of a recording.
 *
 * It exists for two reasons at once. A single-page app of any size takes
 * seconds to draw - Factorial's screens are blank for four to six - so a video
 * that starts filming immediately opens on an empty white page while the
 * narration is already talking. And a demo wants a title anyway. Holding a card
 * over the boot solves both: the app loads behind it, unseen.
 *
 * Injected as an init script so it is present in the very first frame rather
 * than appearing once JavaScript gets round to it. A sessionStorage flag stops
 * it returning on later navigations within the same demo.
 */
const TITLE_SCRIPT = (title: string, subtitle: string, logo: string) => String.raw`
(() => {
  try {
    if (sessionStorage.getItem("vdg.title.done") === "1") return;
  } catch (e) { /* private mode: show it, worst case it shows twice */ }

  const build = () => {
    if (!document.body || document.getElementById("vdg-title")) return;

    const style = document.createElement("style");
    style.textContent = [
      // A popover gets UA styling - a border, margin:auto and width:fit-content -
      // which turns a full-bleed cover into a small framed box in the middle of
      // the page. Every one of these resets is load-bearing.
      "#vdg-title{position:fixed;inset:0;z-index:2147483647;display:flex;",
      "width:100vw;height:100vh;max-width:none;max-height:none;",
      "margin:0;padding:0;border:0;overflow:hidden;",
      "flex-direction:column;align-items:center;justify-content:center;gap:34px;",
      "background:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;",
      "opacity:1;transition:opacity 620ms ease}",
      "#vdg-title.vdg-out{opacity:0}",
      "#vdg-title img{width:340px;max-width:38vw;height:auto;",
      "animation:vdg-rise 760ms cubic-bezier(.2,.7,.3,1) both}",
      "#vdg-title .vdg-t{font-size:40px;font-weight:650;color:#16181d;letter-spacing:-.02em;",
      "text-align:center;max-width:74vw;line-height:1.2;",
      "animation:vdg-rise 760ms cubic-bezier(.2,.7,.3,1) 140ms both}",
      "#vdg-title .vdg-s{font-size:19px;color:#6b7280;margin-top:-20px;text-align:center;",
      "animation:vdg-rise 760ms cubic-bezier(.2,.7,.3,1) 240ms both}",
      "#vdg-title .vdg-rule{width:64px;height:3px;border-radius:2px;background:#ef4b5f;",
      "animation:vdg-rise 760ms cubic-bezier(.2,.7,.3,1) 200ms both}",
      "@keyframes vdg-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}",
    ].join("");
    document.head.appendChild(style);

    const card = document.createElement("div");
    card.id = "vdg-title";
    const logoHtml = __VDG_LOGO__ ? '<img alt="" src="' + __VDG_LOGO__ + '">' : "";
    card.innerHTML =
      logoHtml +
      '<div class="vdg-rule"></div>' +
      '<div class="vdg-t">' + __VDG_TITLE__ + "</div>" +
      (__VDG_SUBTITLE__ ? '<div class="vdg-s">' + __VDG_SUBTITLE__ + "</div>" : "");
    document.body.appendChild(card);

    // Top layer, so a modal dialog opening underneath cannot punch through.
    try {
      card.setAttribute("popover", "manual");
      card.showPopover();
    } catch (e) { /* z-index above is the fallback */ }
  };

  // Paint as soon as there is a <body> to paint into, rather than waiting for
  // DOMContentLoaded. A heavy app spends seconds parsing its scripts before
  // that event fires, and every one of those seconds is a blank frame on film.
  let attempts = 0;
  const tryBuild = () => {
    if (document.body) {
      build();
      return;
    }
    if (attempts++ < 600) requestAnimationFrame(tryBuild);
  };
  tryBuild();
  document.addEventListener("DOMContentLoaded", build);

  window.__vdgTitle = {
    hide: () =>
      new Promise((resolve) => {
        const card = document.getElementById("vdg-title");
        try { sessionStorage.setItem("vdg.title.done", "1"); } catch (e) {}
        if (!card) { resolve(); return; }
        card.classList.add("vdg-out");
        setTimeout(() => {
          card.remove();
          resolve();
        }, 660);
      }),
  };
})();
`
  // Substituted into JavaScript *expressions*, so each must land as a quoted
  // string literal - stripping the quotes spliced the title in as bare words
  // and the init script threw. The placeholders are also deliberately not
  // substrings of one another: "SUBTITLE_TEXT" contains "TITLE_TEXT", so
  // replacing the shorter one first corrupted the longer.
  .replace(/__VDG_TITLE__/g, JSON.stringify(title))
  .replace(/__VDG_SUBTITLE__/g, JSON.stringify(subtitle))
  .replace(/__VDG_LOGO__/g, JSON.stringify(logo));

/** The brand mark as a data URI, so the page needs no network access. */
function logoDataUri(): string {
  const configured = config.brand.logoPath;
  const file = path.isAbsolute(configured)
    ? configured
    : path.join(projectRoot, configured);
  if (!fs.existsSync(file)) return "";

  const ext = path.extname(file).toLowerCase();
  const mime =
    ext === ".svg" ? "image/svg+xml" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

export interface TitleCard {
  title: string;
  subtitle?: string;
}

export async function installTitleCard(
  context: BrowserContext,
  card: TitleCard,
): Promise<void> {
  await context.addInitScript({
    content: TITLE_SCRIPT(card.title, card.subtitle ?? "", logoDataUri()),
  });
}

/** Fade the card away; resolves once it is fully gone. */
export async function hideTitleCard(page: Page): Promise<void> {
  await page.evaluate(() => window.__vdgTitle?.hide()).catch(() => undefined);
}
