const OPENAI_BASE_URL = "https://api.openai.com/v1";

type TranscriptionConfig = {
  endpoint: string;
  model: string;
  apiKey?: string;
};

type ConfigResult =
  | { config: TranscriptionConfig; error?: never }
  | { config?: never; error: string };

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function normalizeBaseUrl(value: string): string | undefined {
  const authority = /^https?:\/\/([^/]+)/i.exec(value)?.[1];
  if (
    !authority ||
    authority.includes("@") ||
    /[\s\\?#]|%(?![\da-f]{2})/i.test(value)
  ) {
    return undefined;
  }
  if (
    [...value].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  ) {
    return undefined;
  }
  const url = URL.parse(value);
  if (
    !url ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopback(url.hostname)))
  ) {
    return undefined;
  }
  return url.href.replace(/\/+$/, "");
}

export function resolveTranscriptionConfig(): ConfigResult {
  const provider =
    process.env.LETTA_TRANSCRIBE_PROVIDER?.trim().toLowerCase() || "openai";
  if (provider !== "openai" && provider !== "openai-compatible") {
    return {
      error:
        "LETTA_TRANSCRIBE_PROVIDER must be one of: openai, openai-compatible.",
    };
  }

  const compatible = provider === "openai-compatible";
  const configuredBase =
    process.env.LETTA_TRANSCRIBE_BASE_URL?.trim() ||
    (compatible ? undefined : OPENAI_BASE_URL);
  if (!configuredBase) {
    return {
      error:
        "LETTA_TRANSCRIBE_BASE_URL is required for openai-compatible transcription.",
    };
  }
  const baseUrl = normalizeBaseUrl(configuredBase);
  if (!baseUrl) {
    return {
      error:
        "LETTA_TRANSCRIBE_BASE_URL must be an HTTPS API base URL (HTTP is allowed on loopback only), with no credentials, query, or fragment.",
    };
  }

  const model =
    process.env.LETTA_TRANSCRIBE_MODEL?.trim() ||
    (compatible ? "whisper-1" : "gpt-4o-transcribe");
  const useLegacyKey = !compatible && baseUrl === OPENAI_BASE_URL;
  const explicitKey = process.env.LETTA_TRANSCRIBE_API_KEY?.trim();
  const apiKey =
    explicitKey ||
    (useLegacyKey ? process.env.OPENAI_API_KEY?.trim() : undefined);
  if (apiKey && !/^[!-~]+$/.test(apiKey)) {
    return {
      error: `${explicitKey ? "LETTA_TRANSCRIBE_API_KEY" : "OPENAI_API_KEY"} contains invalid characters.`,
    };
  }
  if (!apiKey && !compatible) {
    return {
      error: useLegacyKey
        ? "OPENAI_API_KEY not set; transcription skipped."
        : "LETTA_TRANSCRIBE_API_KEY is required for openai transcription.",
    };
  }
  return {
    config: { endpoint: `${baseUrl}/audio/transcriptions`, model, apiKey },
  };
}
