import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { transcribeAudioFile } from "@/channels/transcription/index";

const TRANSCRIPTION_ENV_KEYS = [
  "OPENAI_API_KEY",
  "LETTA_TRANSCRIBE_PROVIDER",
  "LETTA_TRANSCRIBE_BASE_URL",
  "LETTA_TRANSCRIBE_MODEL",
  "LETTA_TRANSCRIBE_API_KEY",
] as const;

const LEGACY_KEY = "sk-legacy-openai-credential-0123456789";
const TRANSCRIBE_KEY = "sk-transcribe-explicit-credential-0123456789";
const COMPATIBLE_BASE = "https://transcribe.example.test/v1";
const COMPATIBLE_URL = `${COMPATIBLE_BASE}/audio/transcriptions`;

const originalFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
let audioDir: string | undefined;

beforeEach(() => {
  for (const key of TRANSCRIPTION_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of TRANSCRIPTION_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  globalThis.fetch = originalFetch;
  if (audioDir) {
    rmSync(audioDir, { recursive: true, force: true });
    audioDir = undefined;
  }
});

function voiceOggPath(): string {
  if (!audioDir) {
    audioDir = mkdtempSync(join(tmpdir(), "letta-transcription-test-"));
  }
  const filePath = join(audioDir, "voice.ogg");
  writeFileSync(filePath, "fake audio bytes");
  return filePath;
}

type FetchMock = ReturnType<typeof mock>;

type SentRequest = {
  url: string;
  init: RequestInit;
  authorization: string | null;
};

function installFetchMock(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchMock {
  const fetchMock = mock(async (input: unknown, init?: RequestInit) =>
    handler(String(input), (init ?? {}) as RequestInit),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function refuseRequests(): FetchMock {
  return installFetchMock((url) => {
    throw new Error(`unexpected request: ${url}`);
  });
}

function sentRequest(fetchMock: FetchMock): SentRequest {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  return {
    url,
    init,
    authorization: new Headers(init.headers).get("Authorization"),
  };
}

async function refuseBeforeRequesting(): Promise<void> {
  const fetchMock = refuseRequests();
  const result = await transcribeAudioFile(voiceOggPath());
  expect(result.success).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
}

describe("transcription credential boundaries", () => {
  test("never sends the legacy OpenAI key to a custom base URL", async () => {
    process.env.OPENAI_API_KEY = LEGACY_KEY;
    process.env.LETTA_TRANSCRIBE_BASE_URL =
      "https://openai-proxy.example.test/v1";

    await refuseBeforeRequesting();
  });

  test("never sends the legacy OpenAI key to a compatible endpoint", async () => {
    process.env.OPENAI_API_KEY = LEGACY_KEY;
    process.env.LETTA_TRANSCRIBE_PROVIDER = "openai-compatible";
    process.env.LETTA_TRANSCRIBE_BASE_URL = COMPATIBLE_BASE;

    const fetchMock = installFetchMock(() =>
      Response.json({ text: "compatible transcript" }),
    );
    const result = await transcribeAudioFile(voiceOggPath());

    expect(result.success).toBe(true);
    expect(sentRequest(fetchMock).authorization).toBeNull();
  });

  test("sends only the explicit transcription key to a compatible endpoint", async () => {
    process.env.OPENAI_API_KEY = LEGACY_KEY;
    process.env.LETTA_TRANSCRIBE_PROVIDER = "openai-compatible";
    process.env.LETTA_TRANSCRIBE_BASE_URL = COMPATIBLE_BASE;
    process.env.LETTA_TRANSCRIBE_API_KEY = TRANSCRIBE_KEY;

    const fetchMock = installFetchMock(() =>
      Response.json({ text: "compatible transcript" }),
    );
    await transcribeAudioFile(voiceOggPath());

    const { url, authorization } = sentRequest(fetchMock);
    expect(url).toBe(COMPATIBLE_URL);
    expect(authorization).toBe(`Bearer ${TRANSCRIBE_KEY}`);
  });

  test("never echoes an upstream error body or the key it repeats", async () => {
    process.env.LETTA_TRANSCRIBE_API_KEY = TRANSCRIBE_KEY;

    const upstreamMessage = `rate limited for ${TRANSCRIBE_KEY}`;
    installFetchMock(() =>
      Response.json({ error: { message: upstreamMessage } }, { status: 429 }),
    );
    const result = await transcribeAudioFile(voiceOggPath());

    expect(result.success).toBe(false);
    expect(result.error).toContain("429");
    expect(result.error).not.toContain(TRANSCRIBE_KEY);
    expect(result.error).not.toContain("rate limited");
  });
});

describe("transcription untrusted configuration", () => {
  test.each([
    ["cleartext http to a non-loopback host", "http://192.168.1.10:8080/v1"],
    [
      "embedded URL credentials",
      "https://user:secret@transcribe.example.test/v1",
    ],
    ["a query string", "https://transcribe.example.test/v1?token=abc"],
    ["a malformed URL", "not-a-valid-url"],
  ])("refuses a base URL with %s", async (_label, baseUrl) => {
    process.env.LETTA_TRANSCRIBE_PROVIDER = "openai-compatible";
    process.env.LETTA_TRANSCRIBE_BASE_URL = baseUrl;

    await refuseBeforeRequesting();
  });

  test("refuses an API key containing control characters", async () => {
    process.env.LETTA_TRANSCRIBE_API_KEY = "sk-bad\u0007key";

    await refuseBeforeRequesting();
  });
});

describe("transcription response boundaries", () => {
  test("refuses a redirect instead of forwarding audio and credentials", async () => {
    process.env.LETTA_TRANSCRIBE_PROVIDER = "openai-compatible";
    process.env.LETTA_TRANSCRIBE_BASE_URL = COMPATIBLE_BASE;
    process.env.LETTA_TRANSCRIBE_API_KEY = TRANSCRIBE_KEY;

    const fetchMock = installFetchMock(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://elsewhere.example.test/hook" },
        }),
    );
    const result = await transcribeAudioFile(voiceOggPath());

    expect(result.success).toBe(false);
    expect(sentRequest(fetchMock).init.redirect).toBe("manual");
  });
});
