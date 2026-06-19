/**
 * Voice memo transcription via OpenAI.
 *
 * Minimal: one API call, no format conversion, no chunking.
 * Telegram voice memos are .ogg/opus which OpenAI transcription supports
 * natively.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

export interface TranscriptionResult {
  success: boolean;
  text?: string;
  error?: string;
}

const OPENAI_TRANSCRIPTION_API_URL =
  "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const TRANSCRIPTION_TIMEOUT_MS = 30_000;

const OPENAI_SUPPORTED_AUDIO_EXTENSIONS = new Set([
  ".flac",
  ".m4a",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpga",
  ".oga",
  ".ogg",
  ".wav",
  ".webm",
]);

function audioMimeTypeForPath(localPath: string): string {
  switch (extname(localPath).toLowerCase()) {
    case ".flac":
      return "audio/flac";
    case ".m4a":
      return "audio/mp4";
    case ".mp3":
    case ".mpeg":
    case ".mpga":
      return "audio/mpeg";
    case ".mp4":
      return "video/mp4";
    case ".oga":
    case ".ogg":
      return "audio/ogg";
    case ".wav":
      return "audio/wav";
    case ".webm":
      return "audio/webm";
    default:
      return "audio/mp4";
  }
}

function prepareOpenAiTranscriptionFile(localPath: string): {
  localPath: string;
  cleanup?: () => void;
} {
  if (OPENAI_SUPPORTED_AUDIO_EXTENSIONS.has(extname(localPath).toLowerCase())) {
    return { localPath };
  }

  const tempDir = mkdtempSync(join(tmpdir(), "letta-transcription-"));
  const convertedPath = join(tempDir, `${basename(localPath)}.m4a`);
  try {
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-i",
        localPath,
        "-vn",
        "-c:a",
        "aac",
        convertedPath,
      ],
      { stdio: "ignore", timeout: TRANSCRIPTION_TIMEOUT_MS },
    );
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(
      `Unsupported audio format ${extname(localPath).replace(/^\./, "") || "unknown"}; ffmpeg conversion failed. ffmpeg is required to transcribe this audio format; install ffmpeg on the channel listener machine. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    localPath: convertedPath,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

/** Check whether an API key is available for transcription. */
export function isTranscriptionConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Transcribe a local audio file using OpenAI's transcription API.
 * Never throws; returns { success: false, error } on failure.
 */
export async function transcribeAudioFile(
  localPath: string,
): Promise<TranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      error: "OPENAI_API_KEY not set; transcription skipped.",
    };
  }

  try {
    const prepared = prepareOpenAiTranscriptionFile(localPath);
    try {
      const buffer = readFileSync(prepared.localPath);
      const filename = basename(prepared.localPath);

      const formData = new FormData();
      const blob = new Blob([buffer], {
        type: audioMimeTypeForPath(prepared.localPath),
      });
      formData.append("file", blob, filename);
      formData.append("model", OPENAI_TRANSCRIPTION_MODEL);

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        TRANSCRIPTION_TIMEOUT_MS,
      );

      try {
        const response = await fetch(OPENAI_TRANSCRIPTION_API_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: formData,
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          return {
            success: false,
            error: `OpenAI transcription API error (${response.status}): ${errorText}`,
          };
        }

        const data = (await response.json()) as { text: string };
        return { success: true, text: data.text };
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      prepared.cleanup?.();
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
