#!/usr/bin/env node
/**
 * Static file server for the offline fixtures.
 *
 *   node fixtures/serve.mjs docs 4173    # the fake help center
 *   node fixtures/serve.mjs app  4174    # the fake product
 *
 * Deliberately dependency-free so the fixtures run before `pnpm install`.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, process.argv[2] ?? "docs");
const port = Number(process.argv[3] ?? 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  let target = path.join(dir, decodeURIComponent(url.pathname));

  // Never serve outside the fixture directory.
  if (!target.startsWith(dir)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = path.join(target, "index.html");
  }
  if (!fs.existsSync(target)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[path.extname(target)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  fs.createReadStream(target).pipe(res);
});

server.listen(port, () => {
  console.log(`fixtures: ${path.basename(dir)} → http://localhost:${port}`);
});
