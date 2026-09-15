import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { runDemo, type RunDemoOptions, type DemoResult } from "../pipeline.js";
import { progress, withJob, type ProgressEvent } from "../log.js";
import { getDemo, type LibraryEntry } from "./library.js";

/**
 * One demo at a time.
 *
 * Every render drives the same demo tenant through one saved session, so two at
 * once would fight over the same browser and the same records. Jobs queue, and
 * the agent can tell the user where they are in line - parallelism would need
 * more demo accounts, not more code.
 */

export type JobState = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  request: string;
  state: JobState;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Progress lines, capped so a long job cannot grow without bound. */
  events: ProgressEvent[];
  result?: LibraryEntry;
  error?: string;
}

const MAX_EVENTS = 400;

export interface JobEvents {
  progress: [{ job: string; event: ProgressEvent }];
  state: [Job];
}

export class JobQueue extends EventEmitter<JobEvents> {
  private readonly jobs = new Map<string, Job>();
  private readonly waiting: string[] = [];
  private active: string | null = null;

  constructor(private readonly run: (options: RunDemoOptions) => Promise<DemoResult> = runDemo) {
    super();
    // The pipeline narrates itself through `log`; mirror anything tagged with a
    // job onto that job's record.
    progress.on("progress", (event) => {
      if (!event.job) return;
      const job = this.jobs.get(event.job);
      if (!job) return;
      job.events.push(event);
      if (job.events.length > MAX_EVENTS) job.events.shift();
      this.emit("progress", { job: job.id, event });
    });
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.queuedAt - a.queuedAt);
  }

  /** Position in line, 0 meaning it is running now. */
  positionOf(id: string): number {
    if (this.active === id) return 0;
    const index = this.waiting.indexOf(id);
    return index < 0 ? -1 : index + 1;
  }

  enqueue(options: RunDemoOptions): Job {
    const job: Job = {
      id: `job_${randomUUID().slice(0, 8)}`,
      request: options.request,
      state: "queued",
      queuedAt: Date.now(),
      events: [],
    };
    this.jobs.set(job.id, job);
    this.waiting.push(job.id);
    this.emit("state", job);

    void this.pump(options, job.id);
    return job;
  }

  private async pump(options: RunDemoOptions, id: string): Promise<void> {
    // Wait for our turn. Simple polling of a one-slot lock: a demo takes
    // minutes, so a tight scheduler would be false precision.
    while (this.active !== null || this.waiting[0] !== id) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!this.jobs.has(id)) return;
    }
    this.waiting.shift();
    this.active = id;

    const job = this.jobs.get(id)!;
    job.state = "running";
    job.startedAt = Date.now();
    this.emit("state", job);

    try {
      const result = await withJob(id, () => this.run(options));
      job.result = getDemo(result.slug) ?? undefined;
      job.state = "done";
    } catch (error) {
      job.error = (error as Error).message;
      job.state = "failed";
    } finally {
      job.finishedAt = Date.now();
      this.active = null;
      this.emit("state", job);
    }
  }
}

export const jobs = new JobQueue();
