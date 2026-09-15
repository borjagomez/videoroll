import fs from "node:fs";
import path from "node:path";
import { config } from "../../config.js";
import { ensureDir } from "../../paths.js";
import { probeDurationMs } from "../../compose/ffmpeg.js";
import {
  wordsFromCharacterTimings,
  type SpokenLine,
  type TtsProvider,
} from "./index.js";

interface WithTimestampsResponse {
  audio_base64: string;
  alignment?: {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
  };
  normalized_alignment?: WithTimestampsResponse["alignment"];
}

/**
 * The default provider, chosen for `/with-timestamps`: it returns per-character
 * timings alongside the audio, so subtitles land on the spoken word instead of
 * being guessed from string length.
 */
export class ElevenLabsProvider implements TtsProvider {
  readonly name = "elevenlabs" as const;
  readonly voice = config.tts.elevenLabsVoice;

  async speak(text: string, outFile: string): Promise<SpokenLine> {
    if (!config.tts.elevenLabsKey) {
      throw new Error(
        "ELEVENLABS_API_KEY is not set. Add it to .env, choose another provider " +
          "with VDG_TTS_PROVIDER, or record with --no-voice.",
      );
    }

    const url =
      `https://api.elevenlabs.io/v1/text-to-speech/${this.voice}/with-timestamps` +
      `?output_format=mp3_44100_128`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": config.tts.elevenLabsKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: config.tts.elevenLabsModel,
        voice_settings: { stability: 0.45, similarity_boost: 0.75, speed: 1.0 },
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 400);
      throw new Error(`ElevenLabs returned ${response.status}: ${detail}`);
    }

    const payload = (await response.json()) as WithTimestampsResponse;
    ensureDir(path.dirname(outFile));
    fs.writeFileSync(outFile, Buffer.from(payload.audio_base64, "base64"));

    const durationMs = await probeDurationMs(outFile);
    const alignment = payload.alignment ?? payload.normalized_alignment;

    if (!alignment) {
      const { estimateWordTimings } = await import("./index.js");
      return {
        audioFile: outFile,
        durationMs,
        words: estimateWordTimings(text, durationMs),
        timingsExact: false,
      };
    }

    return {
      audioFile: outFile,
      durationMs,
      words: wordsFromCharacterTimings(
        alignment.characters,
        alignment.character_start_times_seconds,
        alignment.character_end_times_seconds,
      ),
      timingsExact: true,
    };
  }
}
