import type { BrowserContext, Page } from "playwright";

/**
 * Playwright's video recorder captures the page, not the operating system
 * pointer - so a replay looks like things happen by themselves. This injects a
 * synthetic cursor that we tween to each target before the real click lands,
 * plus a click ripple and a target outline.
 *
 * Delivered as a raw string through addInitScript so the bundler never touches
 * it, and re-installed on every document so it survives navigation.
 */
const CURSOR_SCRIPT = String.raw`
(() => {
  if (window.__vdgCursorInstalled) return;
  window.__vdgCursorInstalled = true;

  const install = () => {
    if (!document.body || document.getElementById("vdg-cursor")) return;

    const style = document.createElement("style");
    style.id = "vdg-cursor-style";
    style.textContent = [
      "#vdg-cursor,#vdg-ripple,#vdg-halo{margin:0;padding:0;border:0;background:none;",
      "overflow:visible;inset:auto}",
      "#vdg-cursor{position:fixed;left:0;top:0;width:26px;height:26px;",
      "pointer-events:none;z-index:2147483647;will-change:transform;",
      "transform:translate(-100px,-100px);filter:drop-shadow(0 2px 4px rgba(0,0,0,.35))}",
      "#vdg-ripple{position:fixed;left:0;top:0;width:14px;height:14px;margin:-7px 0 0 -7px !important;",
      "border-radius:50%;background:rgba(47,86,211,.45);pointer-events:none;",
      "z-index:2147483646;opacity:0;transform:translate(-100px,-100px) scale(1)}",
      "#vdg-ripple.vdg-fire{animation:vdg-ripple 550ms ease-out}",
      "@keyframes vdg-ripple{0%{opacity:.9;transform:var(--vdg-at) scale(.4)}",
      "100%{opacity:0;transform:var(--vdg-at) scale(4.2)}}",
      "#vdg-halo{position:fixed;pointer-events:none;z-index:2147483645;",
      "border:2px solid rgba(47,86,211,.9);border-radius:7px;opacity:0;",
      "box-shadow:0 0 0 4px rgba(47,86,211,.16);transition:opacity 180ms ease}",
    ].join("");
    document.head.appendChild(style);

    // A modal <dialog> renders in the top layer, above any z-index. Opening
    // these as popovers puts them in the top layer too, so the cursor stays
    // visible over dialogs instead of vanishing behind them.
    const toTopLayer = (el) => {
      try {
        el.setAttribute("popover", "manual");
        el.showPopover();
      } catch (e) {
        /* older engines: the z-index above is the fallback */
      }
    };

    const cursor = document.createElement("div");
    cursor.id = "vdg-cursor";
    cursor.innerHTML =
      '<svg viewBox="0 0 26 26" width="26" height="26" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M5 2 L5 20 L10 15.5 L13.2 22.5 L16.4 21 L13.2 14.2 L20 14 Z" ' +
      'fill="#fff" stroke="#16181d" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.body.appendChild(cursor);
    toTopLayer(cursor);

    const ripple = document.createElement("div");
    ripple.id = "vdg-ripple";
    document.body.appendChild(ripple);
    toTopLayer(ripple);

    const halo = document.createElement("div");
    halo.id = "vdg-halo";
    document.body.appendChild(halo);
    toTopLayer(halo);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install);
  } else {
    install();
  }

  let at = { x: -100, y: -100 };

  // The top layer stacks by insertion order, so a <dialog> opened after these
  // popovers renders above them and the cursor disappears behind modals.
  // Re-showing them re-inserts them at the top, which is the only way to stay
  // above a dialog that can open at any point in a demo.
  const raise = () => {
    for (const id of ["vdg-halo", "vdg-ripple", "vdg-cursor"]) {
      const el = document.getElementById(id);
      if (!el || !el.hasAttribute("popover")) continue;
      try {
        el.hidePopover();
        el.showPopover();
      } catch (e) {
        /* not open yet, or popovers unsupported */
      }
    }
  };

  window.__vdgCursor = {
    position: () => at,

    place: (x, y) => {
      install();
      raise();
      at = { x: x, y: y };
      const cursor = document.getElementById("vdg-cursor");
      if (cursor) cursor.style.transform = "translate(" + x + "px," + y + "px)";
    },

    move: (x, y, ms) =>
      new Promise((resolve) => {
        install();
        raise();
        const cursor = document.getElementById("vdg-cursor");
        if (!cursor) {
          at = { x: x, y: y };
          resolve();
          return;
        }
        const from = at;
        const start = performance.now();
        const tick = (now) => {
          const t = Math.min(1, (now - start) / Math.max(1, ms));
          // easeInOutCubic: accelerate away, settle onto the target.
          const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
          const cx = from.x + (x - from.x) * e;
          const cy = from.y + (y - from.y) * e;
          cursor.style.transform = "translate(" + cx + "px," + cy + "px)";
          if (t < 1) requestAnimationFrame(tick);
          else {
            at = { x: x, y: y };
            resolve();
          }
        };
        requestAnimationFrame(tick);
      }),

    ripple: () =>
      new Promise((resolve) => {
        raise();
        const el = document.getElementById("vdg-ripple");
        if (!el) {
          resolve();
          return;
        }
        el.style.setProperty("--vdg-at", "translate(" + at.x + "px," + at.y + "px)");
        el.style.transform = "translate(" + at.x + "px," + at.y + "px)";
        el.classList.remove("vdg-fire");
        void el.offsetWidth;
        el.classList.add("vdg-fire");
        setTimeout(resolve, 560);
      }),

    halo: (rect) => {
      raise();
      const el = document.getElementById("vdg-halo");
      if (!el) return;
      if (!rect) {
        el.style.opacity = "0";
        return;
      }
      el.style.left = rect.x - 4 + "px";
      el.style.top = rect.y - 4 + "px";
      el.style.width = rect.width + 8 + "px";
      el.style.height = rect.height + 8 + "px";
      el.style.opacity = "1";
    },
  };
})();
`;

export interface Point {
  x: number;
  y: number;
}

export async function installCursor(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: CURSOR_SCRIPT });
}

/** Re-run on a page that was open before the script was registered. */
export async function ensureCursor(page: Page): Promise<void> {
  await page.evaluate(CURSOR_SCRIPT).catch(() => undefined);
}

export async function moveCursor(page: Page, to: Point, durationMs: number): Promise<void> {
  await page
    .evaluate(
      ([x, y, ms]) => window.__vdgCursor?.move(x!, y!, ms!),
      [to.x, to.y, durationMs],
    )
    .catch(() => undefined);
  // Keep the real pointer with the drawn one, so :hover styles match the video.
  await page.mouse.move(to.x, to.y).catch(() => undefined);
}

export async function placeCursor(page: Page, at: Point): Promise<void> {
  await page
    .evaluate(([x, y]) => window.__vdgCursor?.place(x!, y!), [at.x, at.y])
    .catch(() => undefined);
}

export async function rippleAt(page: Page): Promise<void> {
  await page.evaluate(() => window.__vdgCursor?.ripple()).catch(() => undefined);
}

export async function highlight(
  page: Page,
  rect: { x: number; y: number; width: number; height: number } | null,
): Promise<void> {
  await page.evaluate((r) => window.__vdgCursor?.halo(r), rect).catch(() => undefined);
}
