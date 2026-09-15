import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { projectRoot } from "../paths.js";
import { config } from "../config.js";

/**
 * A branded cover that opens the recording.
 *
 * It does two jobs. A single-page app takes seconds to draw - Factorial's
 * screens are blank for four to six - so filming from frame one opens on an
 * empty page while the narration is already talking; the cover hides that boot.
 * And a demo wants a title.
 *
 * Three details matter, each of which was a visible defect first:
 *
 * - The brand colour is painted on *every* document, including the blank one a
 *   context opens on. That is a style, not an element, so it cannot flicker -
 *   and it means frame one is already brand-coloured rather than white.
 * - The cover itself is only built on a real document. Building it on
 *   about:blank too meant it appeared, vanished at the navigation, and
 *   reappeared: a blink in the first second.
 * - If a document does swap mid-cover (a start URL that redirects), the rebuild
 *   renders instantly, with no second entrance animation.
 */
const TITLE_SCRIPT = (title: string, cover: string, colour: string) => String.raw`
(() => {
  var COLOUR = __VDG_COLOUR__;

  // Paint the brand colour first, on every document. No elements involved, so
  // there is nothing to flicker - it simply replaces white as the base.
  var paint = () => {
    if (document.documentElement) {
      document.documentElement.style.background = COLOUR;
    }
    if (document.body) document.body.style.background = COLOUR;
  };
  paint();

  try {
    if (sessionStorage.getItem("vdg.title.done") === "1") return;
  } catch (e) { /* private mode: show it, worst case it shows twice */ }

  // The blank document a context opens on gets the colour above but no cover.
  if (location.href === "about:blank") return;

  var seen = false;
  try {
    seen = sessionStorage.getItem("vdg.title.seen") === "1";
    sessionStorage.setItem("vdg.title.seen", "1");
  } catch (e) { /* no storage: treat every build as the first */ }

  var build = () => {
    paint();
    if (!document.body || document.getElementById("vdg-title")) return;

    var style = document.createElement("style");
    style.textContent = [
      // A popover carries UA styling - border, margin:auto, width:fit-content -
      // which turns a full-bleed cover into a small framed box. Every reset
      // here is load-bearing.
      "#vdg-title{position:fixed;inset:0;z-index:2147483647;",
      "display:flex;align-items:center;justify-content:center;",
      "width:100vw;height:100vh;max-width:none;max-height:none;",
      "margin:0;padding:0;border:0;overflow:hidden;",
      "background-color:" + COLOUR + ";",
      __VDG_COVER__ ? "background-image:url(" + __VDG_COVER__ + ");" : "",
      "background-size:cover;background-position:center;background-repeat:no-repeat;",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;",
      "opacity:1;transition:opacity 620ms ease}",
      "#vdg-title.vdg-out{opacity:0}",
      // Sits below the logo, which the cover art centres.
      "#vdg-title .vdg-t{margin:15vh 0 0;color:#fff;font-size:38px;font-weight:600;",
      "letter-spacing:-.015em;line-height:1.25;text-align:center;max-width:70vw;",
      "text-shadow:0 1px 18px rgba(120,0,25,.18);",
      "animation:vdg-up 820ms cubic-bezier(.16,.84,.3,1) 380ms both}",
      "@keyframes vdg-up{from{opacity:0;transform:translateY(38px)}",
      "to{opacity:1;transform:none}}",
      // A rebuild on a second document must not replay the entrance.
      "#vdg-title.vdg-instant .vdg-t{animation:none}",
    ].join("");
    document.head.appendChild(style);

    var card = document.createElement("div");
    card.id = "vdg-title";
    if (seen) card.classList.add("vdg-instant");
    card.innerHTML = '<div class="vdg-t">' + __VDG_TITLE__ + "</div>";
    document.body.appendChild(card);

    // Top layer, so a modal dialog opening underneath cannot punch through.
    try {
      card.setAttribute("popover", "manual");
      card.showPopover();
    } catch (e) { /* the z-index above is the fallback */ }
  };

  // Paint as soon as there is a <body>, rather than waiting for
  // DOMContentLoaded. A heavy app spends seconds parsing scripts before that
  // fires, and every one of those seconds would be a bare frame on film.
  var attempts = 0;
  var tryBuild = () => {
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
        var card = document.getElementById("vdg-title");
        try { sessionStorage.setItem("vdg.title.done", "1"); } catch (e) {}
        if (!card) { resolve(); return; }
        card.classList.add("vdg-out");
        setTimeout(() => {
          card.remove();
          // The app owns the background again once the cover is gone.
          if (document.body) document.body.style.background = "";
          if (document.documentElement) document.documentElement.style.background = "";
          resolve();
        }, 660);
      }),
  };
})();
`
  // Substituted into JavaScript *expressions*, so each must land as a quoted
  // string literal - stripping the quotes spliced the title in as bare words
  // and the init script threw. The placeholders are also deliberately not
  // substrings of one another: an earlier pair was, and replacing the shorter
  // one first corrupted the longer.
  .replace(/__VDG_TITLE__/g, JSON.stringify(title))
  .replace(/__VDG_COVER__/g, JSON.stringify(cover))
  .replace(/__VDG_COLOUR__/g, JSON.stringify(colour));

/** The cover art as a data URI, so the page needs no network access. */
function coverDataUri(): string {
  const configured = config.brand.coverPath;
  if (!configured) return "";
  const file = path.isAbsolute(configured)
    ? configured
    : path.join(projectRoot, configured);
  if (!fs.existsSync(file)) return "";

  const ext = path.extname(file).toLowerCase();
  const mime =
    ext === ".svg"
      ? "image/svg+xml"
      : ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : "image/png";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

export interface TitleCard {
  title: string;
}

export async function installTitleCard(
  context: BrowserContext,
  card: TitleCard,
): Promise<void> {
  await context.addInitScript({
    content: TITLE_SCRIPT(card.title, coverDataUri(), config.brand.color),
  });
}

/** Fade the cover away; resolves once it is fully gone. */
export async function hideTitleCard(page: Page): Promise<void> {
  await page.evaluate(() => window.__vdgTitle?.hide()).catch(() => undefined);
}
