import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Workspace layout. Every stage reads and writes under here, and the whole
 * directory is gitignored - it is derived data, reproducible from the CLI.
 *
 *   workspace/
 *     knowledge/<product>/pages/*.md, index.json, features.json
 *     profiles/<profile>/storageState.json, appmap.json
 *     demos/<slug>/storyboard.json, steps.json, narration.json, timeline.json,
 *                 audio/, raw.webm, out/
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, whether running from `src/` via tsx or `dist/` after a build. */
export const projectRoot = path.resolve(here, "..");

export function workspaceRoot(): string {
  return process.env.VDG_WORKSPACE
    ? path.resolve(process.env.VDG_WORKSPACE)
    : path.join(projectRoot, "workspace");
}

export const knowledgeDir = (product: string) =>
  path.join(workspaceRoot(), "knowledge", product);
export const pagesDir = (product: string) =>
  path.join(knowledgeDir(product), "pages");
export const docIndexPath = (product: string) =>
  path.join(knowledgeDir(product), "index.json");
export const featureCatalogPath = (product: string) =>
  path.join(knowledgeDir(product), "features.json");

export const profileDir = (profile: string) =>
  path.join(workspaceRoot(), "profiles", profile);
export const storageStatePath = (profile: string) =>
  path.join(profileDir(profile), "storageState.json");
export const appMapPath = (profile: string) =>
  path.join(profileDir(profile), "appmap.json");

export const demoDir = (slug: string) =>
  path.join(workspaceRoot(), "demos", slug);
export const storyboardPath = (slug: string) =>
  path.join(demoDir(slug), "storyboard.json");
export const stepsPath = (slug: string) => path.join(demoDir(slug), "steps.json");
export const narrationPath = (slug: string) =>
  path.join(demoDir(slug), "narration.json");
export const timelinePath = (slug: string) =>
  path.join(demoDir(slug), "timeline.json");
export const audioDir = (slug: string) => path.join(demoDir(slug), "audio");
export const rawVideoDir = (slug: string) => path.join(demoDir(slug), "video");
export const outDir = (slug: string) => path.join(demoDir(slug), "out");

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Path relative to the repo root, for log lines the user can click. */
export function rel(p: string): string {
  return path.relative(process.cwd(), p) || ".";
}
