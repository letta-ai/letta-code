/**
 * Voice memo transcription via OpenAI Whisper.
 *
 * Minimal: one API call, no format conversion, no chunking.
 * Telegram voice memos are .ogg/opus which Whisper supports natively.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

export interface TranscriptionResult {
  success: boolean;
  text?: string;
  error?: string;
}

const WHISPER_API_URL = "https://api.openai.com/v1/audio/transcriptions";
const TRANSCRIPTION_TIMEOUT_MS = 10_000;

/** Check whether an API key is available for transcription. */
export function isTranscriptionConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Transcribe a local audio file using OpenAI Whisper.
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
    const buffer = readFileSync(localPath);
    const filename = basename(localPath);

    const formData = new FormData();
    const blob = new Blob([buffer], { type: "audio/ogg" });
    formData.append("file", blob, filename);
    formData.append("model", "whisper-1");

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      TRANSCRIPTION_TIMEOUT_MS,
    );

    try {
      const response = await fetch(WHISPER_API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `Whisper API error (${response.status}): ${errorText}`,
        };
      }

      const data = (await response.json()) as { text: string };
      return { success: true, text: data.text };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
