import fs from "node:fs";
import path from "node:path";
import { workspaceRoot, outDir } from "../paths.js";
import { findRendered } from "../pipeline.js";

/**
 * What has already been rendered.
 *
 * A demo is just files on disk, so the library is a directory listing rather
 * than a database. That is what lets the agent answer "do you have one of X?"
 * in milliseconds instead of spending six minutes discovering it already did.
 */

export interface LibraryEntry {
  slug: string;
  featureName: string;
  durationMs: number;
  stepCount: number;
  renderedAt: string;
  video: string;
  subtitles: string;
  thumbnail: string;
}

const assetUrl = (slug: string, file: string) => `/videos/${slug}/${file}`;

export function listDemos(): LibraryEntry[] {
  const demos = path.join(workspaceRoot(), "demos");
  if (!fs.existsSync(demos)) return [];

  const entries: LibraryEntry[] = [];
  for (const slug of fs.readdirSync(demos)) {
    const found = getDemo(slug);
    if (found) entries.push(found);
  }
  return entries.sort((a, b) => b.renderedAt.localeCompare(a.renderedAt));
}

export function getDemo(slug: string): LibraryEntry | null {
  const rendered = findRendered(slug);
  if (!rendered) return null;

  const stat = fs.statSync(rendered.videoPath);
  return {
    slug,
    featureName: rendered.featureName,
    durationMs: rendered.durationMs,
    stepCount: rendered.stepCount,
    renderedAt: stat.mtime.toISOString(),
    video: assetUrl(slug, "demo.mp4"),
    subtitles: assetUrl(slug, "demo.srt"),
    thumbnail: assetUrl(slug, "thumbnail.png"),
  };
}

/**
 * Resolve a demo asset request to a path inside the workspace.
 *
 * Returns null for anything that escapes the demo's own output directory -
 * these names arrive over HTTP, so a slug of `../../..` must not be able to
 * read the filesystem.
 */
export function resolveAsset(slug: string, file: string): string | null {
  const allowed = new Set(["demo.mp4", "demo.srt", "demo.vtt", "thumbnail.png"]);
  if (!allowed.has(file)) return null;

  const dir = path.resolve(outDir(slug));
  const root = path.resolve(workspaceRoot(), "demos");
  if (!dir.startsWith(root + path.sep)) return null;

  const target = path.join(dir, file);
  return fs.existsSync(target) ? target : null;
}
