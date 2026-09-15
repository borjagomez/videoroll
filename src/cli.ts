#!/usr/bin/env node
import { Command } from "commander";
import { log, red } from "./log.js";

const program = new Command();

program
  .name("vdg")
  .description(
    "Learn a product from its help center, drive its demo environment, " +
      "and record narrated, subtitled feature demos.",
  )
  .version("0.1.0");

program
  .command("doctor")
  .description("check ffmpeg, browsers, credentials and workspace")
  .action(async () => {
    const { doctor } = await import("./commands/doctor.js");
    process.exitCode = await doctor();
  });

program
  .command("learn")
  .argument("<docs-root-url>", "root URL of the product's help center")
  .description("crawl a help center and build the feature catalog")
  .option("-p, --product <slug>", "product slug (inferred from the host otherwise)")
  .option("-m, --max-pages <n>", "maximum pages to fetch", Number)
  .option("-i, --include <regex>", 'keep only matching URLs, e.g. "(time-tracking|absences)"')
  .option(
    "-d, --depth <n>",
    "follow links n hops from the root instead of using the sitemap; 1 means this page and what it links to",
    Number,
  )
  .option("--refresh", "re-crawl even if a corpus already exists")
  .option("--crawl-only", "crawl and store pages, skip feature extraction")
  .option("--ignore-robots", "ignore robots.txt (only for a site you own)")
  .action(async (rootUrl: string, opts) => {
    const { learn } = await import("./commands/learn.js");
    process.exitCode = await learn(rootUrl, opts);
  });

program
  .command("features")
  .description("list or search the catalog built by `learn`")
  .requiredOption("-p, --product <slug>", "product slug")
  .option("-s, --search <query>", "filter by name, alias, category or entity")
  .option("-v, --verbose", "include summaries, prerequisites and documented steps")
  .action(async (opts) => {
    const { features } = await import("./commands/features.js");
    process.exitCode = features(opts);
  });

program
  .command("connect")
  .argument("<app-url>", "URL of the demo environment")
  .description("sign in to a demo environment and map its navigation")
  .requiredOption("-p, --product <slug>", "product slug from `learn`")
  .requiredOption("--profile <name>", "name for this saved session")
  .option("-u, --username <email>", "overrides VDG_DEMO_USERNAME")
  .option("--password <password>", "overrides VDG_DEMO_PASSWORD")
  .option("--manual", "open a window and sign in by hand (SSO, 2FA)")
  .option("--deep", "visit each screen to record what is on it")
  .action(async (appUrl: string, opts) => {
    const { connect } = await import("./commands/connect.js");
    process.exitCode = await connect(appUrl, opts);
  });

program
  .command("record")
  .argument("<request>", 'what to demo, e.g. "approve a time off request"')
  .description("scout the feature in the demo environment and record the video")
  .requiredOption("-p, --product <slug>", "product slug from `learn`")
  .requiredOption("--profile <name>", "session saved by `connect`")
  .option("-f, --feature <id>", "skip matching and use this catalog feature id")
  .option("--steps <path>", "use an existing steps.json instead of scouting")
  .option("--no-voice", "silent video; subtitles and pacing still generated")
  .option("--burn-subs", "also render a copy with subtitles burned in")
  .option("--headed", "show the browser while scouting and recording")
  .option("--raw-narration", "skip the narration polish pass (no model call)")
  .option("--dry-run", "match the feature and print the storyboard, then stop")
  .option("--crf <n>", "x264 quality, lower is better (default 18)", Number)
  .action(async (request: string, opts) => {
    const { record } = await import("./commands/record.js");
    process.exitCode = await record(request, opts);
  });

program
  .command("replay")
  .argument("<slug>", "demo slug under workspace/demos/")
  .description("re-record from steps.json, or check that it still works")
  .option("--verify", "replay against the live product without recording")
  .option("--revoice", "re-run text-to-speech instead of reusing narration.json")
  .option("--raw-narration", "skip the narration polish pass (no model call)")
  .option("--no-voice", "silent video")
  .option("--burn-subs", "also render a copy with subtitles burned in")
  .option("--headed", "show the browser")
  .action(async (slug: string, opts) => {
    const { replayCommand } = await import("./commands/replay.js");
    process.exitCode = await replayCommand(slug, opts);
  });

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    log.blank();
    log.error((err as Error).message);
    if (process.env.VDG_DEBUG) console.error(red(String((err as Error).stack)));
    process.exitCode = 1;
  }
}

void main();
