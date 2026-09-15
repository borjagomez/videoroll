import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { config } from "../config.js";
import { workspaceRoot, ensureDir, rel } from "../paths.js";
import { log, bold, green, red, yellow, dim } from "../log.js";

type Status = "ok" | "warn" | "fail";

interface Check {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

async function probeBinary(bin: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execa(bin, args, { timeout: 10_000 });
    return stdout.split("\n")[0] ?? "";
  } catch {
    return null;
  }
}

async function checkNode(): Promise<Check> {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 22
    ? { name: "Node", status: "ok", detail: `v${process.versions.node}` }
    : {
        name: "Node",
        status: "fail",
        detail: `v${process.versions.node} - need >= 22`,
        fix: "nvm install 22 && nvm use 22",
      };
}

async function checkFfmpeg(): Promise<Check[]> {
  const ffmpeg = await probeBinary(config.ffmpegBin, ["-version"]);
  const ffprobe = await probeBinary(config.ffprobeBin, ["-version"]);
  const mk = (name: string, line: string | null): Check =>
    line
      ? { name, status: "ok", detail: line.replace(/ Copyright.*$/, "").trim() }
      : {
          name,
          status: "fail",
          detail: "not found on PATH",
          fix: "brew install ffmpeg",
        };
  return [mk("ffmpeg", ffmpeg), mk("ffprobe", ffprobe)];
}

/** Burn-in needs libass, which Homebrew's default ffmpeg build leaves out. */
async function checkBurnIn(): Promise<Check> {
  const { hasFilter } = await import("../compose/ffmpeg.js");
  return (await hasFilter("subtitles"))
    ? { name: "Subtitle burn-in", status: "ok", detail: "libass available" }
    : {
        name: "Subtitle burn-in",
        status: "warn",
        detail: "this ffmpeg has no `subtitles` filter, so --burn-subs will fail",
        fix: "videos still carry a soft subtitle track; for burn-in install an ffmpeg with libass",
      };
}

async function checkPlaywright(): Promise<Check> {
  try {
    const { chromium } = await import("playwright");
    const exe = chromium.executablePath();
    if (!fs.existsSync(exe)) {
      return {
        name: "Chromium",
        status: "fail",
        detail: "browser binary not downloaded",
        fix: "pnpm exec playwright install chromium",
      };
    }
    return { name: "Chromium", status: "ok", detail: dim(exe) };
  } catch {
    return {
      name: "Chromium",
      status: "fail",
      detail: "playwright package not installed",
      fix: "pnpm install && pnpm exec playwright install chromium",
    };
  }
}

function checkAnthropic(): Check {
  return config.anthropicApiKey
    ? {
        name: "ANTHROPIC_API_KEY",
        status: "ok",
        detail: `set (…${config.anthropicApiKey.slice(-4)})`,
      }
    : {
        name: "ANTHROPIC_API_KEY",
        status: "fail",
        detail: "not set - learn/plan/scout/narrate cannot run",
        fix: "add ANTHROPIC_API_KEY to .env (see .env.example)",
      };
}

function checkTts(): Check {
  const { provider, elevenLabsKey, openAiKey } = config.tts;
  if (provider === "say") {
    return {
      name: "TTS (say)",
      status: process.platform === "darwin" ? "ok" : "fail",
      detail:
        process.platform === "darwin"
          ? "macOS `say` - fine for iteration, no word timings"
          : "`say` is macOS-only",
      fix: "set VDG_TTS_PROVIDER=elevenlabs",
    };
  }
  if (provider === "openai") {
    return openAiKey
      ? { name: "TTS (openai)", status: "ok", detail: "OPENAI_API_KEY set" }
      : {
          name: "TTS (openai)",
          status: "warn",
          detail: "OPENAI_API_KEY not set",
          fix: "add OPENAI_API_KEY to .env, or record with --no-voice",
        };
  }
  return elevenLabsKey
    ? {
        name: "TTS (elevenlabs)",
        status: "ok",
        detail: `voice ${config.tts.elevenLabsVoice}`,
      }
    : {
        name: "TTS (elevenlabs)",
        status: "warn",
        detail: "ELEVENLABS_API_KEY not set",
        fix: "add ELEVENLABS_API_KEY to .env, or record with --no-voice",
      };
}

function checkWorkspace(): Check {
  const root = workspaceRoot();
  try {
    ensureDir(root);
    const probe = path.join(root, ".write-probe");
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return { name: "Workspace", status: "ok", detail: rel(root) };
  } catch (err) {
    return {
      name: "Workspace",
      status: "fail",
      detail: `${rel(root)} is not writable (${(err as Error).message})`,
    };
  }
}

export async function doctor(): Promise<number> {
  const checks: Check[] = [
    await checkNode(),
    ...(await checkFfmpeg()),
    await checkBurnIn(),
    await checkPlaywright(),
    checkAnthropic(),
    checkTts(),
    checkWorkspace(),
  ];

  log.blank();
  console.log(bold("  vdg doctor"));
  log.blank();

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    const mark =
      c.status === "ok" ? green("✓") : c.status === "warn" ? yellow("!") : red("✗");
    console.log(`  ${mark} ${c.name.padEnd(width)}  ${c.detail}`);
    if (c.status !== "ok" && c.fix) {
      console.log(`    ${dim(`→ ${c.fix}`)}`);
    }
  }
  log.blank();

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;

  if (failed > 0) {
    log.error(`${failed} blocking issue${failed === 1 ? "" : "s"}. Fix those first.`);
  } else if (warned > 0) {
    log.warn(`Ready, with ${warned} warning${warned === 1 ? "" : "s"}.`);
  } else {
    log.ok("Everything is ready.");
  }
  log.blank();
  return failed > 0 ? 1 : 0;
}
