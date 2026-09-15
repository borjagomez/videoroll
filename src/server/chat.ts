import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type Anthropic from "@anthropic-ai/sdk";
import { getClient, buildSystem } from "../llm/client.js";
import { MODEL, EFFORT, config } from "../config.js";
import { searchFeatures } from "../commands/features.js";
import { readArtifact } from "../io.js";
import { featureCatalogPath } from "../paths.js";
import { FeatureCatalogSchema } from "../types.js";
import { listDemos, getDemo } from "./library.js";
import { jobs } from "./jobs.js";
import { fmtDuration } from "../log.js";

/**
 * The agent a chat front end talks to.
 *
 * It owns the judgement the CLI left to a person: which feature someone means,
 * whether a demo already exists, and whether a several-minute render is worth
 * starting. The front end only renders messages.
 */

const SYSTEM = `You help people get product demo videos of Factorial.

You have a library of demos that have already been rendered, a catalogue of
features the product documents, and the ability to record new demos.

How to work:
- When someone asks for a demo, check the library first with list_demos or
  get_demo. A rendered demo comes back instantly; recording one takes several
  minutes. Never make someone wait for something you already have.
- Use search_features to find what the product can actually do. If a request
  does not match anything, say so and suggest the nearest features rather than
  recording something you guessed at.
- Before starting a render, tell the person plainly that it takes a few minutes
  and what you are about to record. Then call render_demo and give them the job
  id.
- Never claim a video exists or hand out a link unless a tool returned it. If a
  render is still running, say so.
- Some features cannot be recorded the usual way, because the demo consumes
  something - booking dates, approving a request from a queue. For those pass
  onePass: true, which films a single live run instead of replaying it.
- Be brief. Link the video, say what it shows, stop.`;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function tools() {
  return [
    betaZodTool({
      name: "list_demos",
      description:
        "Every demo video that has already been rendered and can be linked immediately.",
      inputSchema: z.object({}),
      run: async () =>
        JSON.stringify(
          listDemos().map((d) => ({
            slug: d.slug,
            feature: d.featureName,
            duration: fmtDuration(d.durationMs),
            video: d.video,
          })),
        ),
    }),

    betaZodTool({
      name: "get_demo",
      description:
        "Fetch one already-rendered demo by slug. Returns nothing if it has not been recorded.",
      inputSchema: z.object({
        slug: z.string().describe("Demo slug, e.g. assign-a-time-off-approver-to-an-employee"),
      }),
      run: async ({ slug }) => {
        const demo = getDemo(slug);
        return demo
          ? JSON.stringify(demo)
          : `No rendered demo for "${slug}". Use render_demo to record one.`;
      },
    }),

    betaZodTool({
      name: "search_features",
      description:
        "Search the product's documented features. Use this to find what can be demoed " +
        "and to get the exact feature a request refers to.",
      inputSchema: z.object({
        query: z.string().describe('What the person is asking about, e.g. "approve time off"'),
      }),
      run: async ({ query }) => {
        const catalog = readArtifact(
          featureCatalogPath(config.server.product),
          FeatureCatalogSchema,
        );
        const { results, truncated } = searchFeatures(catalog.features, query);
        if (results.length === 0) return `Nothing in the catalogue matches "${query}".`;
        return JSON.stringify({
          matches: results.map((f) => ({
            id: f.id,
            name: f.name,
            category: f.category,
            summary: f.summary,
          })),
          more: truncated,
        });
      },
    }),

    betaZodTool({
      name: "render_demo",
      description:
        "Record a new demo video. Takes several minutes; returns a job id immediately. " +
        "Tell the person it is running before you call this.",
      inputSchema: z.object({
        request: z
          .string()
          .describe('What to demo, in plain language, e.g. "approve a time off request"'),
        featureId: z
          .string()
          .optional()
          .describe("Catalogue feature id, when search_features gave you an exact match"),
        onePass: z
          .boolean()
          .optional()
          .describe(
            "Film one live run instead of replaying. Needed when the demo consumes " +
              "something - booking dates, taking a request off a queue.",
          ),
      }),
      run: async ({ request, featureId, onePass }) => {
        const job = jobs.enqueue({
          request,
          product: config.server.product,
          profile: config.server.profile,
          ...(featureId ? { featureId } : {}),
          ...(onePass ? { onePass: true } : {}),
        });
        const position = jobs.positionOf(job.id);
        return JSON.stringify({
          jobId: job.id,
          state: job.state,
          queuePosition: position,
          note:
            position > 0
              ? `${position} job(s) ahead; only one demo can record at a time.`
              : "Recording now. Expect a few minutes.",
        });
      },
    }),

    betaZodTool({
      name: "job_status",
      description: "How a render is going, and the video once it is finished.",
      inputSchema: z.object({ jobId: z.string() }),
      run: async ({ jobId }) => {
        const job = jobs.get(jobId);
        if (!job) return `No job ${jobId}.`;
        return JSON.stringify({
          state: job.state,
          queuePosition: jobs.positionOf(jobId),
          latest: job.events.slice(-4).map((e) => e.message),
          ...(job.result ? { demo: job.result } : {}),
          ...(job.error ? { error: job.error } : {}),
        });
      },
    }),
  ];
}

export interface ChatEvent {
  type: "text" | "tool" | "done" | "error";
  data: unknown;
}

/**
 * Run one turn, yielding events as they happen.
 *
 * Streaming matters here: a turn can include a tool call that takes a moment,
 * and a chat that shows nothing until the whole reply is ready feels broken.
 */
export async function* chat(
  messages: ChatMessage[],
): AsyncGenerator<ChatEvent, void, unknown> {
  // The library is small and changes rarely, so it sits in the cached prefix.
  const library = listDemos()
    .map((d) => `${d.slug} — ${d.featureName} (${fmtDuration(d.durationMs)})`)
    .join("\n");

  const runner = getClient().beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 4096,
    system: buildSystem({
      cachedPrefix: library ? `Demos already rendered:\n${library}` : "",
      instructions: SYSTEM,
      user: "",
    }),
    output_config: { effort: EFFORT },
    tools: tools(),
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_iterations: 12,
    stream: true,
  });

  try {
    for await (const stream of runner) {
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta" &&
          event.delta.text
        ) {
          yield { type: "text", data: { delta: event.delta.text } };
        }
      }
      const message = await stream.finalMessage();
      for (const block of message.content) {
        if (block.type === "tool_use") {
          yield { type: "tool", data: { name: block.name, input: block.input } };
        }
      }
    }
    const final = await runner.done();
    yield { type: "done", data: { stop: final.stop_reason } };
  } catch (error) {
    yield { type: "error", data: { message: (error as Error).message } };
  }
}

export type ChatRunner = ReturnType<typeof tools>;
export type { Anthropic };
