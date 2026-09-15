import { z } from "zod";

/**
 * Every artifact written under `workspace/` has a schema here, and every read
 * parses through it. Stage boundaries are the contract: if `scout` writes a
 * steps.json that `record` cannot parse, we want to know at the boundary and
 * not three stages later inside ffmpeg.
 */

/* ------------------------------------------------------------------ *
 * Locators
 * ------------------------------------------------------------------ */

/**
 * Ordered strongest-to-weakest. The scout is instructed to reach for the
 * earliest kind that uniquely identifies an element, because role/label
 * locators survive redesigns that break CSS selectors.
 */
export const LocatorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("role"),
    role: z.string(),
    name: z.string().optional(),
    exact: z.boolean().optional(),
    nth: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("label"),
    name: z.string(),
    exact: z.boolean().optional(),
    nth: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("placeholder"),
    name: z.string(),
    exact: z.boolean().optional(),
    nth: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("text"),
    name: z.string(),
    exact: z.boolean().optional(),
    nth: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("testid"),
    value: z.string(),
    nth: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("css"),
    selector: z.string(),
    nth: z.number().int().nonnegative().optional(),
  }),
]);
export type Locator = z.infer<typeof LocatorSchema>;

/* ------------------------------------------------------------------ *
 * Demo script (workspace/demos/<slug>/steps.json)
 * ------------------------------------------------------------------ */

export const StepActionSchema = z.enum([
  "navigate",
  "click",
  "fill",
  "select",
  "press",
  "hover",
  "scroll",
  "wait",
]);
export type StepAction = z.infer<typeof StepActionSchema>;

export const StepSchema = z.object({
  id: z.number().int().positive(),
  action: StepActionSchema,
  /** Target element. Absent for `navigate` and `wait`. */
  locator: LocatorSchema.optional(),
  /** `navigate` destination. */
  url: z.url().optional(),
  /** Text for `fill`, option for `select`, key for `press`. */
  value: z.string().optional(),
  /** Text to wait for, when action is `wait`. */
  waitForText: z.string().optional(),
  /** Spoken line for this step. */
  narration: z.string(),
  /** Short on-screen label. */
  caption: z.string(),
  /** Minimum dwell after the action, before the next step. */
  settleMs: z.number().int().nonnegative().default(800),
  /** Draw an outline around the target before interacting. */
  highlight: z.boolean().default(true),
  /** Free-text note from the scout (why this step, what it verified). */
  note: z.string().optional(),
});
export type Step = z.infer<typeof StepSchema>;

export const DemoScriptSchema = z.object({
  slug: z.string(),
  request: z.string(),
  featureId: z.string().optional(),
  featureName: z.string(),
  product: z.string(),
  profile: z.string(),
  startUrl: z.url(),
  createdAt: z.string(),
  /** Divergences the scout found between the docs and the live app. */
  divergences: z.array(z.string()).default([]),
  steps: z.array(StepSchema).min(1),
});
export type DemoScript = z.infer<typeof DemoScriptSchema>;

/* ------------------------------------------------------------------ *
 * Help-center knowledge (workspace/knowledge/<product>/)
 * ------------------------------------------------------------------ */

export const DocPageSchema = z.object({
  url: z.url(),
  title: z.string(),
  /** Filename under knowledge/<product>/pages/, e.g. "a1b2c3d4.md". */
  file: z.string(),
  hash: z.string(),
  breadcrumb: z.array(z.string()).default([]),
  headings: z.array(z.string()).default([]),
  wordCount: z.number().int().nonnegative(),
  fetchedAt: z.string(),
});
export type DocPage = z.infer<typeof DocPageSchema>;

export const DocIndexSchema = z.object({
  product: z.string(),
  rootUrl: z.url(),
  crawledAt: z.string(),
  pages: z.array(DocPageSchema),
});
export type DocIndex = z.infer<typeof DocIndexSchema>;

export const FeatureSchema = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  summary: z.string(),
  category: z.string(),
  sourceUrls: z.array(z.string()).default([]),
  /** Steps as the documentation describes them - a hypothesis, not ground truth. */
  docSteps: z.array(z.string()).default([]),
  prerequisites: z.array(z.string()).default([]),
  /** Domain nouns the feature operates on ("time off request", "expense"). */
  entities: z.array(z.string()).default([]),
});
export type Feature = z.infer<typeof FeatureSchema>;

export const FeatureCatalogSchema = z.object({
  product: z.string(),
  rootUrl: z.url(),
  generatedAt: z.string(),
  pageCount: z.number().int().nonnegative(),
  features: z.array(FeatureSchema),
});
export type FeatureCatalog = z.infer<typeof FeatureCatalogSchema>;

/* ------------------------------------------------------------------ *
 * Demo environment binding (workspace/profiles/<profile>/)
 * ------------------------------------------------------------------ */

export const AppRouteSchema = z.object({
  label: z.string(),
  /** Absent for nav items that are buttons rather than links (SPA menus). */
  url: z.url().optional(),
  kind: z.enum(["link", "button"]).default("link"),
  /** The nav group this item sits in. */
  section: z.string().optional(),
  /** What is on that screen, filled in by `connect --deep`. */
  description: z.string().optional(),
});
export type AppRoute = z.infer<typeof AppRouteSchema>;

export const AppMapSchema = z.object({
  profile: z.string(),
  product: z.string(),
  baseUrl: z.url(),
  capturedAt: z.string(),
  routes: z.array(AppRouteSchema),
});
export type AppMap = z.infer<typeof AppMapSchema>;

/* ------------------------------------------------------------------ *
 * Storyboard (workspace/demos/<slug>/storyboard.json)
 * ------------------------------------------------------------------ */

export const SceneSchema = z.object({
  intent: z.string(),
  docAction: z.string(),
  narrationBeat: z.string(),
  sourceUrl: z.string().optional(),
});
export type Scene = z.infer<typeof SceneSchema>;

export const StoryboardSchema = z.object({
  slug: z.string(),
  request: z.string(),
  product: z.string(),
  profile: z.string(),
  featureId: z.string().optional(),
  featureName: z.string(),
  startUrl: z.url(),
  createdAt: z.string(),
  scenes: z.array(SceneSchema).min(1),
  notes: z.string().optional(),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

/* ------------------------------------------------------------------ *
 * Narration (workspace/demos/<slug>/narration.json)
 * ------------------------------------------------------------------ */

export const WordTimingSchema = z.object({
  word: z.string(),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
});
export type WordTiming = z.infer<typeof WordTimingSchema>;

export const NarrationStepSchema = z.object({
  stepId: z.number().int().positive(),
  text: z.string(),
  /** Relative to the demo directory; absent when --no-voice. */
  audioFile: z.string().optional(),
  durationMs: z.number().nonnegative(),
  /** Word timings are exact from ElevenLabs, estimated elsewhere. */
  words: z.array(WordTimingSchema).default([]),
  timingsExact: z.boolean().default(false),
});
export type NarrationStep = z.infer<typeof NarrationStepSchema>;

export const NarrationSchema = z.object({
  slug: z.string(),
  provider: z.string(),
  voice: z.string().optional(),
  wpm: z.number().positive(),
  totalMs: z.number().nonnegative(),
  steps: z.array(NarrationStepSchema),
});
export type Narration = z.infer<typeof NarrationSchema>;

/* ------------------------------------------------------------------ *
 * Recording timeline (workspace/demos/<slug>/timeline.json)
 * ------------------------------------------------------------------ */

export const TimelineEntrySchema = z.object({
  stepId: z.number().int().positive(),
  /** Offset from the first recorded frame, after lead-in calibration. */
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
});
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

export const TimelineSchema = z.object({
  slug: z.string(),
  videoFile: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Frames recorded before step 1 begins - the one calibrated offset. */
  leadInMs: z.number().nonnegative(),
  tailMs: z.number().nonnegative(),
  totalMs: z.number().nonnegative(),
  entries: z.array(TimelineEntrySchema),
});
export type Timeline = z.infer<typeof TimelineSchema>;
