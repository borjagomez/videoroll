import { serve } from "../server/index.js";
import { log } from "../log.js";

/**
 * Run the HTTP service.
 *
 * Long-lived by design: it holds the queue and the demo library, and only one
 * render happens at a time because they all share one demo tenant.
 */
export async function serveCommand(): Promise<number> {
  await serve();
  // Resolve only when the process is told to stop.
  await new Promise<void>((resolve) => {
    const stop = () => {
      log.blank();
      log.info("Shutting down.");
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
