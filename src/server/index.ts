import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import { config } from "../config.js";
import { listDemos, getDemo, resolveAsset } from "./library.js";
import { jobs } from "./jobs.js";
import { chat, type ChatMessage } from "./chat.js";
import { assertReady } from "../pipeline.js";
import { musicFile } from "../compose/compose.js";
import { log } from "../log.js";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".srt": "application/x-subrip",
  ".vtt": "text/vtt",
  ".png": "image/png",
};

/** Open a Server-Sent Events stream and keep proxies from closing it. */
function openStream(reply: FastifyReply): (event: string, data: unknown) => void {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  // A render runs for minutes with nothing to say in between; without this an
  // intermediary will decide the connection is dead and drop it.
  const ping = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
  reply.raw.on("close", () => clearInterval(ping));

  return (event, data) => {
    if (reply.raw.writableEnded) return;
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

/**
 * Stream a demo asset, honouring Range so a video can be scrubbed.
 *
 * Without range support a browser has to download the whole file before it can
 * seek, and Safari will not play the video at all.
 */
function sendAsset(reply: FastifyReply, file: string, range?: string): void {
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file)] ?? "application/octet-stream";
  const match = range?.match(/bytes=(\d*)-(\d*)/);

  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : size - 1;
    if (start >= size || end >= size || start > end) {
      reply.code(416).header("content-range", `bytes */${size}`).send();
      return;
    }
    reply
      .code(206)
      .header("content-type", type)
      .header("content-range", `bytes ${start}-${end}/${size}`)
      .header("accept-ranges", "bytes")
      .header("content-length", end - start + 1)
      .send(fs.createReadStream(file, { start, end }));
    return;
  }

  reply
    .header("content-type", type)
    .header("accept-ranges", "bytes")
    .header("content-length", size)
    .send(fs.createReadStream(file));
}

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  void app.register(cors, {
    origin: config.server.origins.includes("*") ? true : config.server.origins,
  });

  /**
   * Bearer auth, except on /health.
   *
   * Asset routes also accept `?token=` because a <video> tag cannot set an
   * Authorization header - the src is fetched by the browser, not by our code.
   */
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/health")) return;
    if (!config.server.token) return; // unset: open, for local development

    const header = request.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const query = (request.query as { token?: string } | undefined)?.token;
    const supplied = bearer ?? (request.url.startsWith("/videos/") ? query : undefined);

    if (supplied !== config.server.token) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => {
    const problems: string[] = [];
    try {
      assertReady(config.server.product, config.server.profile);
    } catch (error) {
      problems.push((error as Error).message);
    }
    // Report the music bed explicitly: a missing track renders silently
    // unscored, which is easy to ship without noticing.
    const music = musicFile();
    return {
      ok: problems.length === 0,
      product: config.server.product,
      profile: config.server.profile,
      demos: listDemos().length,
      music: music ? { enabled: true, path: music } : { enabled: false },
      problems,
    };
  });

  app.get("/demos", async () => ({ demos: listDemos() }));

  app.get<{ Params: { slug: string } }>("/demos/:slug", async (request, reply) => {
    const demo = getDemo(request.params.slug);
    if (!demo) return reply.code(404).send({ error: "not rendered" });
    return demo;
  });

  app.get<{ Params: { id: string }; Querystring: { stream?: string } }>(
    "/jobs/:id",
    async (request, reply) => {
      const job = jobs.get(request.params.id);
      if (!job) return reply.code(404).send({ error: "no such job" });

      if (request.query.stream !== "1") {
        return { ...job, queuePosition: jobs.positionOf(job.id) };
      }

      const send = openStream(reply);
      for (const event of job.events) send("stage", { job: job.id, ...event });
      if (job.state === "done" || job.state === "failed") {
        send("state", job);
        reply.raw.end();
        return reply;
      }

      const onProgress = ({ job: id, event }: { job: string; event: unknown }) => {
        if (id === job.id) send("stage", { job: id, ...(event as object) });
      };
      const onState = (updated: typeof job) => {
        if (updated.id !== job.id) return;
        send("state", updated);
        if (updated.state === "done" || updated.state === "failed") {
          jobs.off("progress", onProgress);
          jobs.off("state", onState);
          reply.raw.end();
        }
      };
      jobs.on("progress", onProgress);
      jobs.on("state", onState);
      reply.raw.on("close", () => {
        jobs.off("progress", onProgress);
        jobs.off("state", onState);
      });
      return reply;
    },
  );

  app.post<{ Body: { messages?: ChatMessage[]; message?: string } }>(
    "/chat",
    async (request, reply) => {
      const body = request.body ?? {};
      const messages: ChatMessage[] =
        body.messages ?? (body.message ? [{ role: "user", content: body.message }] : []);
      if (messages.length === 0) {
        return reply.code(400).send({ error: "messages or message is required" });
      }

      const send = openStream(reply);

      // Relay pipeline progress for any job started during this turn, so the
      // chat shows the render happening rather than going silent for minutes.
      const onProgress = ({ job, event }: { job: string; event: { message: string } }) =>
        send("stage", { job, message: event.message });
      jobs.on("progress", onProgress);
      reply.raw.on("close", () => jobs.off("progress", onProgress));

      try {
        for await (const event of chat(messages)) {
          if (event.type === "text") send("text", event.data);
          else if (event.type === "tool") send("tool", event.data);
          else if (event.type === "error") send("error", event.data);
          else send("done", event.data);
        }
      } catch (error) {
        send("error", { message: (error as Error).message });
      } finally {
        jobs.off("progress", onProgress);
        reply.raw.end();
      }
      return reply;
    },
  );

  app.get<{ Params: { slug: string; file: string } }>(
    "/videos/:slug/:file",
    async (request, reply) => {
      const file = resolveAsset(request.params.slug, request.params.file);
      if (!file) return reply.code(404).send({ error: "not found" });
      sendAsset(reply, file, request.headers.range);
      return reply;
    },
  );

  return app;
}

export async function serve(): Promise<void> {
  const app = buildServer();
  await app.listen({ port: config.server.port, host: config.server.host });

  log.ok(`vdg listening on http://${config.server.host}:${config.server.port}`);
  log.detail(`product ${config.server.product} · profile ${config.server.profile}`);
  if (!config.server.token) {
    log.warn("VDG_API_TOKEN is unset - the API is open. Set it before exposing this.");
  }
}
