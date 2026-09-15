import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";

/* Minimal CLI output. No spinner library - stages are long and log-driven. */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

export const dim = (s: string) => paint("2", s);
export const bold = (s: string) => paint("1", s);
export const green = (s: string) => paint("32", s);
export const yellow = (s: string) => paint("33", s);
export const red = (s: string) => paint("31", s);
export const cyan = (s: string) => paint("36", s);

export type LogLevel = "step" | "info" | "detail" | "ok" | "warn" | "error";

export interface ProgressEvent {
  /** The job this came from, when it was emitted inside one. */
  job?: string;
  level: LogLevel;
  message: string;
  at: number;
}

/**
 * Every progress message in the pipeline, as it happens.
 *
 * The stages already narrate themselves through `log`, so rather than threading
 * a callback through a hundred call sites, the same calls are mirrored onto
 * this emitter. A server can stream them; the CLI ignores them entirely.
 */
export const progress = new EventEmitter<{ progress: [ProgressEvent] }>();

const jobContext = new AsyncLocalStorage<string>();

/**
 * Tag everything logged inside `fn` with a job id.
 *
 * Async-local rather than a parameter, because the pipeline was written without
 * any notion of a job and should not have to learn one. Concurrent jobs stay
 * correctly attributed even though they share the same module-level `log`.
 */
export function withJob<T>(job: string, fn: () => Promise<T>): Promise<T> {
  return jobContext.run(job, fn);
}

export const currentJob = (): string | undefined => jobContext.getStore();

/** Colour codes are for the terminal; consumers want the words. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function emit(level: LogLevel, message: string): void {
  const job = jobContext.getStore();
  progress.emit("progress", {
    ...(job ? { job } : {}),
    level,
    message: plain(message),
    at: Date.now(),
  });
}

export const log = {
  step: (msg: string) => {
    emit("step", msg);
    console.log(`${cyan("›")} ${msg}`);
  },
  info: (msg: string) => {
    emit("info", msg);
    console.log(`  ${msg}`);
  },
  detail: (msg: string) => {
    emit("detail", msg);
    console.log(dim(`  ${msg}`));
  },
  ok: (msg: string) => {
    emit("ok", msg);
    console.log(`${green("✓")} ${msg}`);
  },
  warn: (msg: string) => {
    emit("warn", msg);
    console.warn(`${yellow("!")} ${msg}`);
  },
  error: (msg: string) => {
    emit("error", msg);
    console.error(`${red("✗")} ${msg}`);
  },
  blank: () => console.log(""),
};

export function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function fmtCount(n: number, singular: string, plural = `${singular}s`) {
  return `${n} ${n === 1 ? singular : plural}`;
}
