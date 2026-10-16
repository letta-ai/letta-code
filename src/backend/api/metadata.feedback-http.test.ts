import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submitFeedbackMetadata } from "@/backend/api/metadata";
import { settingsManager } from "@/settings-manager";

type CapturedRequest = {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: string;
};

const envKeys = [
  "HOME",
  "LETTA_BASE_URL",
  "LETTA_API_KEY",
  "LETTA_DESKTOP_MODE",
  "LETTA_LOCAL_BACKEND_EXPERIMENTAL",
  "LETTA_SKIP_KEYCHAIN_CHECK",
] as const;

describe("submitFeedbackMetadata auth routing", () => {
  let home: string;
  let savedEnv: Record<string, string | undefined>;
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(async () => {
    savedEnv = Object.fromEntries(
      envKeys.map((key) => [key, process.env[key]]),
    );
    home = await mkdtemp(join(tmpdir(), "metadata-feedback-"));
    process.env.HOME = home;
    process.env.LETTA_SKIP_KEYCHAIN_CHECK = "1";
    delete process.env.LETTA_API_KEY;
    delete process.env.LETTA_DESKTOP_MODE;
    delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;

    await settingsManager.reset();
    await settingsManager.initialize();

    mockFetch = mock(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await settingsManager.reset();
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await rm(home, { recursive: true, force: true });
  });

  function lastRequest(): CapturedRequest {
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as unknown as [
      string | URL,
      RequestInit,
    ];
    return {
      url: url.toString(),
      method: init.method,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: (init.body as string | undefined) ?? "",
    };
  }

  test("Desktop runtime with a cloud backend still sends the resolved credential (LET-12955)", async () => {
    // Mirrors the reported environment: LETTA_DESKTOP_MODE=1 with
    // LETTA_BASE_URL=api.letta.com. The CLI process holds the OAuth grant in
    // the desktop credentials session (no LETTA_API_KEY env, no settings-env
    // key), so the caller passes apiKey=undefined.
    process.env.LETTA_DESKTOP_MODE = "1";
    process.env.LETTA_BASE_URL = "https://api.letta.com";
    await settingsManager.setSecureTokens({ apiKey: "secure-key-1" });

    await submitFeedbackMetadata(undefined, "device-1", {
      message: "feedback from the desktop app",
      feature: "letta-code-agent-feedback",
    });

    const request = lastRequest();
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.letta.com/v1/metadata/feedback");
    expect(request.headers.Authorization).toBe("Bearer secure-key-1");
    expect(request.headers["X-Letta-Code-Device-ID"]).toBe("device-1");
    expect(request.headers["X-Letta-Source"]).toBe("letta-code");
    expect(JSON.parse(request.body)).toMatchObject({
      message: "feedback from the desktop app",
      feature: "letta-code-agent-feedback",
    });
  });

  test("cloud runtime uses a secure-token API key when the caller passes none", async () => {
    delete process.env.LETTA_DESKTOP_MODE;
    await settingsManager.setSecureTokens({ apiKey: "secure-key-2" });

    await submitFeedbackMetadata(undefined, "device-2", {
      message: "feedback from a plain CLI terminal",
    });

    const request = lastRequest();
    expect(request.url).toBe("https://api.letta.com/v1/metadata/feedback");
    expect(request.headers.Authorization).toBe("Bearer secure-key-2");
  });

  test("keeps a caller-provided key when no central credential exists", async () => {
    delete process.env.LETTA_DESKTOP_MODE;

    await submitFeedbackMetadata("caller-key-3", "device-3", {
      message: "feedback with an explicit key",
    });

    const request = lastRequest();
    expect(request.url).toBe("https://api.letta.com/v1/metadata/feedback");
    expect(request.headers.Authorization).toBe("Bearer caller-key-3");
  });

  test("desktop runtime with an environment key keeps using it", async () => {
    // Shell-tool children of a Desktop session receive LETTA_API_KEY in their
    // environment (the current desktop token) and pass it as the caller key.
    process.env.LETTA_DESKTOP_MODE = "1";
    process.env.LETTA_BASE_URL = "https://api.letta.com";
    process.env.LETTA_API_KEY = "env-key-4";

    await submitFeedbackMetadata("env-key-4", "device-4", {
      message: "feedback from an agent-run CLI",
    });

    const request = lastRequest();
    expect(request.url).toBe("https://api.letta.com/v1/metadata/feedback");
    expect(request.headers.Authorization).toBe("Bearer env-key-4");
  });

  test("desktop runtime with a loopback backend keeps the proxy route and key", async () => {
    process.env.LETTA_DESKTOP_MODE = "1";
    process.env.LETTA_BASE_URL = "http://127.0.0.1:8899";
    await settingsManager.setSecureTokens({ apiKey: "secure-key-5" });

    await submitFeedbackMetadata(undefined, "device-5", {
      message: "feedback through the desktop proxy",
    });

    const request = lastRequest();
    expect(request.url).toBe("http://127.0.0.1:8899/v1/metadata/feedback");
    expect(request.headers.Authorization).toBe("Bearer secure-key-5");
  });

  test("metadata feedback still targets the cloud route from another non-loopback server", async () => {
    delete process.env.LETTA_DESKTOP_MODE;
    process.env.LETTA_BASE_URL = "https://self-hosted.example.com";

    await submitFeedbackMetadata("caller-key-6", "device-6", {
      message: "feedback with a non-cloud base URL configured",
    });

    const request = lastRequest();
    expect(request.url).toBe("https://api.letta.com/v1/metadata/feedback");
    expect(request.headers.Authorization).toBe("Bearer caller-key-6");
  });
});
