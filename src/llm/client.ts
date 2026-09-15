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
