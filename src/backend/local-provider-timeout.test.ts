import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveZaiConnection } from "@/backend/dev/pi-model-factory";
import {
  createOrUpdateLocalProvider,
  getLocalProviderByName,
} from "@/backend/local/local-provider-auth-store";
import {
  createLocalProviderFetch,
  parseLocalProviderTimeout,
} from "@/backend/local/local-provider-timeout";

describe("local provider timeout", () => {
  test("parses OpenCode-style provider timeout values", () => {
    expect(parseLocalProviderTimeout("300000")).toBe(300_000);
    expect(parseLocalProviderTimeout("600s")).toBe(600_000);
    expect(parseLocalProviderTimeout("10m")).toBe(600_000);
    expect(parseLocalProviderTimeout("false")).toBe(false);
    expect(() => parseLocalProviderTimeout("soon")).toThrow(
      "Invalid local provider timeout",
    );
  });

  test("wraps provider fetch with a provider timeout and disables Bun fetch timeout", async () => {
    let capturedInit: (RequestInit & { timeout?: unknown }) | undefined;
    const wrapped = createLocalProviderFetch({
      timeout: 600_000,
      fetch: (async (_input, init) => {
        capturedInit = init as RequestInit & { timeout?: unknown };
        return new Response("ok");
      }) as typeof fetch,
    });

    const response = await wrapped("https://example.invalid/v1/chat", {
      method: "POST",
    });

    expect(await response.text()).toBe("ok");
    expect(capturedInit?.timeout).toBe(false);
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  test("stores provider base URL and timeout for local model resolution", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-provider-timeout-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "lmstudio",
        providerName: "lc-lmstudio",
        apiKey: "not-needed",
        baseURL: "http://127.0.0.1:1234/v1",
        timeout: 600_000,
      });
      const stored = await getLocalProviderByName("lc-lmstudio", storageDir);
      expect(stored).toMatchObject({
        base_url: "http://127.0.0.1:1234/v1",
        timeout: 600_000,
      });

      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "zai_coding",
        providerName: "lc-zai-coding",
        apiKey: "test-zai-coding-key",
        baseURL: "http://localhost:9999/v1",
        timeout: false,
      });
      expect(
        resolveZaiConnection({
          storageDir,
          preferredProviderType: "zai_coding",
        }),
      ).toMatchObject({
        apiKey: "test-zai-coding-key",
        baseURL: "http://localhost:9999/v1",
        providerName: "zai-coding",
        timeout: false,
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
