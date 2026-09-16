import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { MODEL, EFFORT, requireAnthropicKey } from "../config.js";
import { log, dim } from "../log.js";

/** The reply exceeded max_tokens and came back incomplete. Callers may retry smaller. */
export class OutputTruncatedError extends Error {}

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: requireAnthropicKey() });
  return client;
}

/**
 * System prompt split into a stable prefix and a volatile suffix.
 *
 * The prefix - a help-center corpus, an app map - is the expensive part and it
 * does not change between calls in a stage, so it sits behind a 1h cache
 * breakpoint. Anything that varies per call (the request, a timestamp) must go
 * after it or the prefix match breaks and the cache silently stops paying.
 */
export interface Prompt {
  /** Cached. Keep byte-identical across calls in a stage. */
  cachedPrefix?: string;
  /** Not cached. Per-call instructions. */
  instructions: string;
  user: string;
  maxTokens?: number;
  effort?: typeof EFFORT;
}

export function buildSystem(p: Prompt): Anthropic.Beta.BetaTextBlockParam[] {
  const blocks: Anthropic.Beta.BetaTextBlockParam[] = [];
  if (p.cachedPrefix) {
    blocks.push({
      type: "text",
      text: p.cachedPrefix,
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
  }
  blocks.push({ type: "text", text: p.instructions });
  return blocks;
}

/**
 * Cache the conversation, not just the system prefix.
 *
 * A tool loop resends the whole conversation on every iteration, so with a
 * breakpoint only on the system prefix the cost grows with the square of the
 * loop length: one 50-iteration scout run billed 2,921,003 input tokens against
 * a conversation that ended at 122,285 - the same tokens bought twenty-four
 * times over. Top-level cache control marks the last cacheable block of each
 * request automatically, so the breakpoint rolls forward with the conversation
 * and every turn reads the previous one back at a tenth of the price.
 *
 * It costs nothing to be wrong about: a miss just bills what it would have
 * billed anyway.
 */
export const CACHE_CONVERSATION: Anthropic.Beta.BetaCacheControlEphemeral = {
  type: "ephemeral",
};

/**
 * Let the model forget screens it has already left.
 *
 * Every action the scout takes returns a fresh snapshot of the page, and those
 * pile up: fifty turns means fifty descriptions of the same app, of which only
 * the last is true. Clearing the superseded ones keeps the context - and the
 * bill - from growing with the length of the session.
 *
 * `keep` is what stops this from being lobotomy: the recent screens stay, and
 * the tool *inputs* are never cleared, so the model can always see what it did,
 * just not the stale pictures of where it did it.
 *
 * The trigger is deliberately well above the point where clearing becomes
 * worthwhile. Each clear rewrites the prefix and so throws away the cache above,
 * which is the opposite of what CACHE_CONVERSATION is for; firing rarely means
 * long cached stretches broken by the occasional reset, rather than a cache that
 * never survives a turn.
 */
export const FORGET_STALE_SCREENS = {
  edits: [
    {
      type: "clear_tool_uses_20250919" as const,
      trigger: { type: "input_tokens" as const, value: 60_000 },
      keep: { type: "tool_uses" as const, value: 5 },
    },
  ],
};

/** The beta that FORGET_STALE_SCREENS rides on. */
export const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";

export function reportUsage(label: string, usage: Anthropic.Beta.BetaUsage): void {
  const read = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  const fresh = usage.input_tokens ?? 0;
  const cache =
    read > 0
      ? `cache hit ${read.toLocaleString()}`
      : written > 0
        ? `cache write ${written.toLocaleString()}`
        : "no cache";
  log.detail(
    dim(
      `${label}: ${fresh.toLocaleString()} in / ` +
        `${(usage.output_tokens ?? 0).toLocaleString()} out, ${cache}`,
    ),
  );
}

/**
 * Did this failure mean "the answer did not fit"?
 *
 * `.parse()` parses before returning, so hitting max_tokens surfaces as a JSON
 * error rather than reaching the `stop_reason` check below. The SDK wraps it in
 * a plain `AnthropicError` with no distinguishing type or code, so matching the
 * message is the only way to tell this apart from a real API failure - the
 * `instanceof` keeps that matching narrow.
 */
function isTruncatedOutput(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  return (
    error instanceof Anthropic.AnthropicError &&
    /Failed to parse structured output/.test(error.message) &&
    /SyntaxError|JSON/.test(error.message)
  );
}

/** One call that must return data matching `schema`. */
export async function structured<S extends z.ZodTypeAny>(
  label: string,
  prompt: Prompt,
  schema: S,
): Promise<z.infer<S>> {
  const maxTokens = prompt.maxTokens ?? 16000;

  let response;
  try {
    response = await getClient().beta.messages.parse({
      model: MODEL,
      max_tokens: maxTokens,
      system: buildSystem(prompt),
      messages: [{ role: "user", content: prompt.user }],
      output_config: {
        effort: prompt.effort ?? EFFORT,
        format: betaZodOutputFormat(schema),
      },
    });
  } catch (error) {
    if (isTruncatedOutput(error)) {
      throw new OutputTruncatedError(
        `${label}: the reply was cut off at max_tokens (${maxTokens}), leaving ` +
          `incomplete JSON`,
      );
    }
    throw error;
  }

  reportUsage(label, response.usage);

  if (response.stop_reason === "refusal") {
    throw new Error(
      `${label}: the model declined this request` +
        (response.stop_details?.explanation
          ? ` (${response.stop_details.explanation})`
          : ""),
    );
  }
  if (response.stop_reason === "max_tokens") {
    throw new OutputTruncatedError(
      `${label}: response hit max_tokens (${maxTokens}) and was truncated`,
    );
  }
  if (!response.parsed_output) {
    throw new Error(`${label}: model returned no parseable structured output`);
  }
  return response.parsed_output as z.infer<S>;
}

/** One call that returns prose. */
export async function text(label: string, prompt: Prompt): Promise<string> {
  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: prompt.maxTokens ?? 8000,
    system: buildSystem(prompt),
    messages: [{ role: "user", content: prompt.user }],
    output_config: { effort: prompt.effort ?? EFFORT },
  });

  reportUsage(label, response.usage);

  if (response.stop_reason === "refusal") {
    throw new Error(`${label}: the model declined this request`);
  }
  return response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
