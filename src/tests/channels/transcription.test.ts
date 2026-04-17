import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

describe("isTranscriptionConfigured", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.OPENAI_API_KEY = originalKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  test("returns false when OPENAI_API_KEY is not set", async () => {
    delete process.env.OPENAI_API_KEY;
    const { isTranscriptionConfigured } = await import(
      "../../channels/transcription/index"
    );
    expect(isTranscriptionConfigured()).toBe(false);
  });

  test("returns true when OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    const { isTranscriptionConfigured } = await import(
      "../../channels/transcription/index"
    );
    expect(isTranscriptionConfigured()).toBe(true);
  });
});

describe("transcribeAudioFile", () => {
  let originalKey: string | undefined;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    originalKey = process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.OPENAI_API_KEY = originalKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    globalThis.fetch = originalFetch;
  });

  test("returns error when OPENAI_API_KEY is not set", async () => {
    delete process.env.OPENAI_API_KEY;
    const { transcribeAudioFile } = await import(
      "../../channels/transcription/index"
    );
    const result = await transcribeAudioFile("/tmp/nonexistent.ogg");
    expect(result.success).toBe(false);
    expect(result.error).toContain("OPENAI_API_KEY");
  });

  test("returns error when file does not exist", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    const { transcribeAudioFile } = await import(
      "../../channels/transcription/index"
    );
    const result = await transcribeAudioFile(
      "/tmp/definitely-does-not-exist-12345.ogg",
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("calls Whisper API and returns transcribed text", async () => {
    process.env.OPENAI_API_KEY = "sk-test";

    const fetchMock = mock(async () => {
      return new Response(JSON.stringify({ text: "Hello world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Write a temp file so readFileSync succeeds
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const path = "/tmp/letta-test-voice.ogg";
    writeFileSync(path, "fake audio data");

    try {
      const { transcribeAudioFile } = await import(
        "../../channels/transcription/index"
      );
      const result = await transcribeAudioFile(path);

      expect(result.success).toBe(true);
      expect(result.text).toBe("Hello world");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, options] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
      expect(options.method).toBe("POST");
      expect(options.headers).toEqual(
        expect.objectContaining({ Authorization: "Bearer sk-test" }),
      );
    } finally {
      unlinkSync(path);
    }
  });

  test("returns error on API failure", async () => {
    process.env.OPENAI_API_KEY = "sk-test";

    globalThis.fetch = mock(async () => {
      return new Response("Rate limited", { status: 429 });
    }) as unknown as typeof fetch;

    const { writeFileSync, unlinkSync } = await import("node:fs");
    const path = "/tmp/letta-test-voice-fail.ogg";
    writeFileSync(path, "fake audio data");

    try {
      const { transcribeAudioFile } = await import(
        "../../channels/transcription/index"
      );
      const result = await transcribeAudioFile(path);

      expect(result.success).toBe(false);
      expect(result.error).toContain("429");
    } finally {
      unlinkSync(path);
    }
  });
});
