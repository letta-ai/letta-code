import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCloudApiKey,
  retryAfterMsFromBody,
} from "@/providers/chatgpt-provider-auth";
import { settingsManager } from "@/settings-manager";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let testHomeDir = "";

// Refresh reads the device ID from settings, so isolate settings in a temp HOME.
beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-chatgpt-auth-home-"));
  process.env.HOME = testHomeDir;
  process.env.USERPROFILE = testHomeDir;
  await settingsManager.initialize();
});

afterEach(async () => {
  await settingsManager.reset();
  if (testHomeDir) await rm(testHomeDir, { recursive: true, force: true });
  testHomeDir = "";
  process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
});

async function withoutEnvApiKey<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.LETTA_API_KEY;
  delete process.env.LETTA_API_KEY;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.LETTA_API_KEY;
    else process.env.LETTA_API_KEY = previous;
  }
}

describe("resolveCloudApiKey", () => {
  test("surfaces the refresh failure reason instead of a generic message", async () => {
    const result = await withoutEnvApiKey(() =>
      resolveCloudApiKey({
        settings: { env: {}, refreshToken: "letta-refresh-token" },
        now: Date.now(),
        unauthorizedMessage: "Sign in with Letta.",
        refreshAccessToken: async () => {
          throw new Error(
            "Failed to refresh access token from app.letta.com: invalid_grant",
          );
        },
      }),
    );

    expect(result).toEqual({
      success: false,
      error: {
        code: "refresh_failed",
        message:
          "Failed to refresh access token from app.letta.com: invalid_grant",
      },
    });
  });

  test("uses the caller's feature-specific unauthorized message", async () => {
    const result = await withoutEnvApiKey(() =>
      resolveCloudApiKey({
        settings: { env: {} },
        now: Date.now(),
        unauthorizedMessage:
          "Sign in with Letta to read ChatGPT reset credits.",
      }),
    );

    expect(result).toEqual({
      success: false,
      error: {
        code: "unauthorized",
        message: "Sign in with Letta to read ChatGPT reset credits.",
      },
    });
  });

  test("returns a stored key that is not near expiry without refreshing", async () => {
    let refreshed = false;
    const now = Date.now();
    const result = await withoutEnvApiKey(() =>
      resolveCloudApiKey({
        settings: {
          env: { LETTA_API_KEY: "stored-key" },
          refreshToken: "letta-refresh-token",
          tokenExpiresAt: now + 60 * 60 * 1000,
        },
        now,
        unauthorizedMessage: "Sign in with Letta.",
        refreshAccessToken: async () => {
          refreshed = true;
          throw new Error("should not refresh");
        },
      }),
    );

    expect(result).toEqual({ success: true, apiKey: "stored-key" });
    expect(refreshed).toBe(false);
  });
});

describe("retryAfterMsFromBody", () => {
  test("clamps negative retry hints to zero", () => {
    expect(retryAfterMsFromBody({ retry_after_ms: -5 })).toBe(0);
    expect(retryAfterMsFromBody({ retryAfterMs: 1500 })).toBe(1500);
    expect(retryAfterMsFromBody(null)).toBeUndefined();
  });
});
