import fs from "node:fs";
import path from "node:path";
import { config } from "../../config.js";
import { ensureDir } from "../../paths.js";
import { probeDurationMs } from "../../compose/ffmpeg.js";
import { estimateWordTimings, type SpokenLine, type TtsProvider } from "./index.js";

/** No timing data, so subtitles are estimated from word length. */
export class OpenAiProvider implements TtsProvider {
  readonly name = "openai" as const;
  readonly voice = config.tts.openAiVoice;

  async speak(text: string, outFile: string): Promise<SpokenLine> {
    if (!config.tts.openAiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set. Add it to .env, choose another provider with " +
          "VDG_TTS_PROVIDER, or record with --no-voice.",
      );
    }

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.tts.openAiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.tts.openAiModel,
        voice: this.voice,
        input: text,
        response_format: "mp3",
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 400);
      throw new Error(`OpenAI TTS returned ${response.status}: ${detail}`);
    }

    ensureDir(path.dirname(outFile));
    fs.writeFileSync(outFile, Buffer.from(await response.arrayBuffer()));
    const durationMs = await probeDurationMs(outFile);

    return {
      audioFile: outFile,
      durationMs,
      words: estimateWordTimings(text, durationMs),
      timingsExact: false,
    };
  }
}
