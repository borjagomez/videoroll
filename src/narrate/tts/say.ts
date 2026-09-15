import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execa } from "execa";
import { ensureDir } from "../../paths.js";
import { ffmpeg, probeDurationMs } from "../../compose/ffmpeg.js";
import { estimateWordTimings, type SpokenLine, type TtsProvider } from "./index.js";

/**
 * macOS's built-in voice. Free and offline, so the whole pipeline can be
 * exercised with no API keys - useful while iterating on pacing and subtitles
 * before spending on a real voice.
 */
export class SayProvider implements TtsProvider {
  readonly name = "say" as const;
  readonly voice = process.env.VDG_SAY_VOICE ?? "Samantha";

  async speak(text: string, outFile: string): Promise<SpokenLine> {
    if (process.platform !== "darwin") {
      throw new Error("The `say` provider is macOS-only. Use elevenlabs or openai.");
    }
    ensureDir(path.dirname(outFile));
    const aiff = path.join(
      os.tmpdir(),
      `vdg-say-${Date.now()}-${Math.random().toString(36).slice(2)}.aiff`,
    );

    try {
      await execa("say", ["-v", this.voice, "-o", aiff, text]);
      await ffmpeg(["-i", aiff, "-c:a", "libmp3lame", "-q:a", "4", outFile], "say encode");
    } finally {
      fs.rmSync(aiff, { force: true });
    }

    const durationMs = await probeDurationMs(outFile);
    return {
      audioFile: outFile,
      durationMs,
      words: estimateWordTimings(text, durationMs),
      timingsExact: false,
    };
  }
}
