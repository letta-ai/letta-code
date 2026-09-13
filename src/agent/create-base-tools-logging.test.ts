import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { addBaseToolsToServer } from "@/agent/create";
import { settingsManager } from "@/settings-manager";

await settingsManager.initialize();

const originalApiKey = process.env.LETTA_API_KEY;
const originalBaseUrl = process.env.LETTA_BASE_URL;
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;

describe("addBaseToolsToServer logging", () => {
  const warn = mock((_message?: unknown) => {});

  beforeEach(() => {
    process.env.LETTA_API_KEY = "test-key";
    process.env.LETTA_BASE_URL = "https://example.test";
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response('{"message":"Unauthorized"}', { status: 401 }),
      ),
    ) as unknown as typeof fetch;
    warn.mockClear();
    console.warn = warn;
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.LETTA_API_KEY;
    else process.env.LETTA_API_KEY = originalApiKey;
    if (originalBaseUrl === undefined) delete process.env.LETTA_BASE_URL;
    else process.env.LETTA_BASE_URL = originalBaseUrl;
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  });

  test("does not print a best-effort bootstrap failure in quiet mode", async () => {
    expect(await addBaseToolsToServer({ quiet: true })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  test("prints the same failure outside quiet mode", async () => {
    expect(await addBaseToolsToServer()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "Failed to call /v1/tools/add-base-tools: API error (401)",
    );
  });
});
