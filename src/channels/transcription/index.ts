import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { resolveTranscriptionConfig } from "./config";

export interface TranscriptionResult {
  success: boolean;
  text?: string;
  error?: string;
}

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

export function getTranscriptionConfigError(): string | undefined {
  return resolveTranscriptionConfig().error;
}

export function isTranscriptionConfigured(): boolean {
  return getTranscriptionConfigError() === undefined;
}

export async function transcribeAudioFile(
  localPath: string,
): Promise<TranscriptionResult> {
  const { config, error } = resolveTranscriptionConfig();
  if (!config) return { success: false, error };

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
      formData.append("model", config.model);

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        TRANSCRIPTION_TIMEOUT_MS,
      );

      try {
        const response = await fetch(config.endpoint, {
          method: "POST",
          headers: config.apiKey
            ? { Authorization: `Bearer ${config.apiKey}` }
            : {},
          body: formData,
          redirect: "manual",
          signal: controller.signal,
        });

        if (
          response.redirected ||
          (response.status >= 300 && response.status < 400)
        ) {
          void response.body?.cancel().catch(() => {});
          return {
            success: false,
            error: `Transcription API returned a redirect (${response.status}). Configure the final API base URL.`,
          };
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          return {
            success: false,
            error: `Transcription API error (${response.status}).`,
          };
        }

        const data = (await response.json()) as { text?: unknown } | null;
        if (typeof data?.text !== "string") {
          return {
            success: false,
            error: "Transcription response did not contain transcript text.",
          };
        }
        return { success: true, text: data.text };
      } catch {
        return {
          success: false,
          error: controller.signal.aborted
            ? "Transcription request timed out after 30 seconds."
            : "Transcription request failed. Check the API endpoint and response.",
        };
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
