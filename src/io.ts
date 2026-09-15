import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { z } from "zod";
import { ensureDir, rel } from "./paths.js";

/** Read JSON and parse it through its schema. Throws with the artifact path. */
export function readArtifact<T extends z.ZodTypeAny>(
  file: string,
  schema: T,
): z.infer<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`Missing artifact: ${rel(file)}`);
  }
  const parsed = schema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `Malformed artifact ${rel(file)}:\n${formatZodError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function artifactExists(file: string): boolean {
  return fs.existsSync(file);
}

/** Validate before writing, so a bad artifact never reaches disk. */
export function writeArtifact<T extends z.ZodTypeAny>(
  file: string,
  schema: T,
  value: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Refusing to write invalid ${rel(file)}:\n${formatZodError(parsed.error)}`,
    );
  }
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(parsed.data, null, 2) + "\n", "utf8");
  return parsed.data;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}

const SLUG_MAX = 72;

/** Ids show up in the CLI and in `--feature`, so they must not end mid-word. */
export function slugify(input: string): string {
  const full = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (full.length <= SLUG_MAX) return full || "untitled";

  const cut = full.slice(0, SLUG_MAX + 1);
  const lastBoundary = cut.lastIndexOf("-");
  const trimmed =
    lastBoundary > SLUG_MAX / 2 ? cut.slice(0, lastBoundary) : cut.slice(0, SLUG_MAX);
  return trimmed.replace(/-+$/, "") || "untitled";
}

export function shortHash(input: string, length = 10): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, length);
}

export const nowIso = (): string => new Date().toISOString();
