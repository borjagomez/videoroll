import type { Page } from "playwright";
import type { Locator } from "../types.js";

/** One interactive element as the model sees it, plus what code needs to pin it. */
export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  tag: string;
  inputType?: string;
  value?: string;
  disabled: boolean;
  testid?: string;
  placeholder?: string;
  labelText?: string;
  text?: string;
  /** Nearest row/list-item text - "Approve" alone is ambiguous, in a row it isn't. */
  context?: string;
  /** Whether each candidate strategy identifies this element on its own. */
  unique: {
    roleName: boolean;
    label: boolean;
    placeholder: boolean;
    text: boolean;
    testid: boolean;
  };
  /** Index among elements sharing the same role+name, for the `nth` fallback. */
  roleNameIndex: number;
  cssPath: string;
}

export interface Snapshot {
  url: string;
  title: string;
  headings: string[];
  status: string[];
  elements: SnapshotElement[];
  byRef: Map<string, SnapshotElement>;
  /** The rendering handed to the model. */
  text: string;
}

const REF_ATTRIBUTE = "data-vdg-ref";

/** Separator for composite tally keys; no accessible name contains it. */
const SEP = " :: ";

/**
 * Collects every interactive element, stamps each with a ref attribute, and
 * reports the facts needed to choose a durable locator. Selector *policy* lives
 * in `deriveLocator` below, in Node, so the model never has to reason about it.
 */
async function collect(page: Page, refAttribute: string) {
  return page.evaluate((REF: string) => {
    const INTERACTIVE = [
      "a[href]",
      "button",
      "input",
      "select",
      "textarea",
      "summary",
      "[role='button']",
      "[role='link']",
      "[role='menuitem']",
      "[role='tab']",
      "[role='checkbox']",
      "[role='radio']",
      "[role='switch']",
      "[role='option']",
      "[role='combobox']",
      "[contenteditable='true']",
    ].join(",");

    const isVisible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return false;
      if (Number(style.opacity) === 0) return false;
      // Inside an aria-hidden subtree, so not part of the accessible UI.
      return !el.closest("[aria-hidden='true']");
    };

    const implicitRole = (el: Element): string => {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
      if (tag === "button" || tag === "summary") return "button";
      if (tag === "select") return el.hasAttribute("multiple") ? "listbox" : "combobox";
      if (tag === "textarea") return "textbox";
      if (/^h[1-6]$/.test(tag)) return "heading";
      if (tag === "input") {
        const type = (el.getAttribute("type") ?? "text").toLowerCase();
        if (type === "button" || type === "submit" || type === "reset") return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "range") return "slider";
        if (type === "search") return "searchbox";
        if (type === "number") return "spinbutton";
        return "textbox";
      }
      return "generic";
    };

    // A label's textContent includes any form control nested inside it, so a
    // wrapped <select> yields "Type of absence" followed by every option in the
    // list. That produces a locator that breaks the moment an option is added.
    const labelText = (label: Element): string => {
      const clone = label.cloneNode(true) as Element;
      for (const control of clone.querySelectorAll("select, option, input, textarea")) {
        control.remove();
      }
      return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
    };

    const labelFor = (el: Element): string => {
      const id = el.getAttribute("id");
      if (id) {
        const explicit = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (explicit) return labelText(explicit);
      }
      const wrapping = el.closest("label");
      return wrapping ? labelText(wrapping) : "";
    };

    const accessibleName = (el: Element): string => {
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const parts = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (parts) return parts;
      }

      const label = labelFor(el);
      if (label) return label;

      const own = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (own && own.length <= 80) return own;

      const placeholder = el.getAttribute("placeholder");
      if (placeholder && placeholder.trim()) return placeholder.trim();

      const title = el.getAttribute("title");
      if (title && title.trim()) return title.trim();

      const alt = el.querySelector("img[alt]")?.getAttribute("alt");
      if (alt && alt.trim()) return alt.trim();

      const value = (el as HTMLInputElement).value;
      return typeof value === "string" && value.length <= 40 ? value.trim() : "";
    };

    const rowContext = (el: Element): string => {
      const container = el.closest("tr, li, [role='row'], [role='listitem']");
      if (!container) return "";
      const text = (container.textContent ?? "").replace(/\s+/g, " ").trim();
      return text.length > 140 ? text.slice(0, 140) + "…" : text;
    };

    const cssPathFor = (el: Element): string => {
      const parts: string[] = [];
      let node: Element | null = el;
      while (node && node.nodeType === 1 && parts.length < 6) {
        const current: Element = node;
        let part = current.tagName.toLowerCase();
        const id = current.getAttribute("id");
        if (id) {
          parts.unshift(`#${CSS.escape(id)}`);
          break;
        }
        const parent: Element | null = current.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter(
            (c) => c.tagName === current.tagName,
          );
          if (siblings.length > 1) {
            part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
          }
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(" > ");
    };

    // Clear refs from a previous snapshot so stale ones cannot silently resolve.
    for (const stale of document.querySelectorAll(`[${REF}]`)) {
      stale.removeAttribute(REF);
    }

    const raw: Array<Record<string, unknown>> = [];
    let index = 0;
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (!isVisible(el)) continue;
      if (raw.length >= 200) break;

      const ref = `e${++index}`;
      el.setAttribute(REF, ref);

      const input = el as HTMLInputElement;
      raw.push({
        ref,
        role: implicitRole(el),
        name: accessibleName(el),
        tag: el.tagName.toLowerCase(),
        inputType: el.getAttribute("type") ?? undefined,
        value: typeof input.value === "string" ? input.value.slice(0, 60) : undefined,
        disabled:
          el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
        testid:
          el.getAttribute("data-testid") ??
          el.getAttribute("data-test-id") ??
          el.getAttribute("data-test") ??
          undefined,
        placeholder: el.getAttribute("placeholder") ?? undefined,
        labelText: labelFor(el) || undefined,
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || undefined,
        context: rowContext(el) || undefined,
        cssPath: cssPathFor(el),
      });
    }

    const headings: string[] = [];
    for (const el of document.querySelectorAll("h1, h2, h3")) {
      if (!isVisible(el)) continue;
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text) headings.push(text);
    }

    const status: string[] = [];
    for (const el of document.querySelectorAll("[role='status'], [role='alert'], .toast")) {
      if (!isVisible(el)) continue;
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text) status.push(text);
    }

    return {
      url: location.href,
      title: document.title,
      headings: headings.slice(0, 12),
      status: status.slice(0, 5),
      raw,
    };
  }, refAttribute);
}

function tally(values: Array<string | undefined>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function render(snapshot: Omit<Snapshot, "text" | "byRef">): string {
  const lines: string[] = [`url: ${snapshot.url}`, `title: ${snapshot.title}`];
  if (snapshot.headings.length > 0) {
    lines.push(`headings: ${snapshot.headings.join(" | ")}`);
  }
  if (snapshot.status.length > 0) {
    lines.push(`status messages: ${snapshot.status.join(" | ")}`);
  }
  lines.push("", "interactive elements:");

  let lastContext = "";
  for (const el of snapshot.elements) {
    if (el.context && el.context !== lastContext) {
      lastContext = el.context;
      lines.push(`  in row: ${el.context}`);
    }
    if (!el.context) lastContext = "";

    const bits = [`[${el.ref}]`, el.role];
    if (el.name) bits.push(`"${el.name}"`);
    if (el.inputType && el.tag === "input") bits.push(`type=${el.inputType}`);
    if (el.value) bits.push(`value="${el.value}"`);
    if (el.disabled) bits.push("(disabled)");
    lines.push(`  ${el.context ? "  " : ""}${bits.join(" ")}`);
  }
  return lines.join("\n");
}

export async function captureSnapshot(page: Page): Promise<Snapshot> {
  const collected = await collect(page, REF_ATTRIBUTE);
  const raw = collected.raw as unknown as Array<
    Omit<SnapshotElement, "unique" | "roleNameIndex">
  >;

  const roleNameCounts = tally(
    raw.map((e) => (e.name ? `${e.role}${SEP}${e.name}` : undefined)),
  );
  const labelCounts = tally(raw.map((e) => e.labelText));
  const placeholderCounts = tally(raw.map((e) => e.placeholder));
  const textCounts = tally(raw.map((e) => e.text));
  const testidCounts = tally(raw.map((e) => e.testid));

  const roleNameSeen = new Map<string, number>();
  const elements: SnapshotElement[] = raw.map((element) => {
    const roleNameKey = element.name ? `${element.role}${SEP}${element.name}` : "";
    const index = roleNameKey ? (roleNameSeen.get(roleNameKey) ?? 0) : 0;
    if (roleNameKey) roleNameSeen.set(roleNameKey, index + 1);

    const { labelText, placeholder, text, testid } = element;
    return {
      ...element,
      roleNameIndex: index,
      unique: {
        roleName: roleNameKey !== "" && roleNameCounts.get(roleNameKey) === 1,
        label: labelText !== undefined && labelCounts.get(labelText) === 1,
        placeholder:
          placeholder !== undefined && placeholderCounts.get(placeholder) === 1,
        text: text !== undefined && textCounts.get(text) === 1,
        testid: testid !== undefined && testidCounts.get(testid) === 1,
      },
    };
  });

  const base = {
    url: collected.url,
    title: collected.title,
    headings: collected.headings,
    status: collected.status,
    elements,
  };

  return {
    ...base,
    byRef: new Map(elements.map((e) => [e.ref, e])),
    text: render(base),
  };
}

/**
 * Selector policy, applied in code rather than left to the model.
 *
 * Role and label locators describe what an element *is* to a user, so they
 * survive restyling and DOM churn; a CSS path describes only where it happens
 * to sit today. Strongest wins, and a non-unique match falls back to an index
 * rather than to a weaker strategy - `nth` on a role still outlives an
 * nth-of-type chain.
 */
export function deriveLocator(element: SnapshotElement): Locator {
  if (element.name && element.role !== "generic") {
    if (element.unique.roleName) {
      return { kind: "role", role: element.role, name: element.name, exact: true };
    }
    return {
      kind: "role",
      role: element.role,
      name: element.name,
      exact: true,
      nth: element.roleNameIndex,
    };
  }
  if (element.labelText && element.unique.label) {
    return { kind: "label", name: element.labelText, exact: true };
  }
  if (element.placeholder && element.unique.placeholder) {
    return { kind: "placeholder", name: element.placeholder, exact: true };
  }
  if (element.testid && element.unique.testid) {
    return { kind: "testid", value: element.testid };
  }
  if (element.text && element.unique.text) {
    return { kind: "text", name: element.text, exact: true };
  }
  return { kind: "css", selector: element.cssPath };
}

export const refSelector = (ref: string) => `[${REF_ATTRIBUTE}="${ref}"]`;
