import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_CHATGPT_PROVIDER_NAME,
  setLocalOAuthProvider,
} from "@/backend/local/local-provider-auth-store";
import {
  formatChatGPTUsageQuotaRows,
  formatChatGPTUsageSnapshot,
  normalizeWhamUsageResponse,
  readChatGPTUsage,
} from "@/providers/chatgpt-usage-service";
import { createCredentialScopedCacheKey } from "@/providers/credential-scoped-cache";

async function withEnv<T>(
  updates: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(
    Object.keys(updates).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("ChatGPT usage service", () => {
  test("normalizes WHAM rate limit windows and builds a compact summary", () => {
    const snapshot = normalizeWhamUsageResponse({
      providerName: "chatgpt-plus-pro",
      nowMs: Date.parse("2026-06-18T12:00:00Z"),
      raw: {
        plan_type: "plus",
        rate_limit: {
          limit_reached: false,
          primary_window: {
            used_percent: 25.5,
            limit_window_seconds: 18_000,
            reset_after_seconds: 7_200,
          },
          secondary_window: {
            used_percent: 12,
            limit_window_seconds: 604_800,
            reset_after_seconds: 432_000,
          },
          additional_rate_limits: [
            {
              name: "extra",
              used_percent: 40,
              window_minutes: 60,
              reset_after_seconds: 1_800,
            },
          ],
        },
        credits: {
          balance: "12.5",
        },
      },
    });

    expect(snapshot.providerName).toBe("chatgpt-plus-pro");
    expect(snapshot.planType).toBe("plus");
    expect(snapshot.limitReached).toBe(false);
    expect(snapshot.primary).toEqual({
      label: "primary",
      usedPercent: 25.5,
      windowDurationMins: 300,
      resetsAt: 1_781_791_200,
    });
    expect(snapshot.secondary?.windowDurationMins).toBe(10_080);
    expect(snapshot.additional[0]).toEqual({
      label: "extra",
      usedPercent: 40,
      windowDurationMins: 60,
      resetsAt: 1_781_785_800,
    });
    expect(snapshot.credits).toEqual({ balance: "12.5" });
    expect(snapshot.summary).toBe(
      "Usage: 5h 74.5% left resets in 2h · 7d 88% left resets in 5d · extra 1h 60% left resets in 30m · credits 12.5",
    );
    expect(
      formatChatGPTUsageQuotaRows(snapshot, new Date("2026-06-18T12:00:00Z")),
    ).toEqual(["5h 74.5% left resets in 2h", "7d 88% left resets in 5d"]);
  });

  test("accepts camelCase fields and millisecond reset timestamps", () => {
    const snapshot = normalizeWhamUsageResponse({
      providerName: "chatgpt-work",
      nowMs: Date.parse("2026-06-18T12:00:00Z"),
      raw: {
        rateLimit: {
          primaryWindow: {
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: Date.parse("2026-06-18T15:00:00Z"),
          },
        },
        rateLimitReachedType: "primary",
      },
    });

    expect(snapshot.rateLimitReachedType).toBe("primary");
    expect(snapshot.primary?.resetsAt).toBe(1_781_794_800);
    expect(snapshot.summary).toBe("Usage: 5h 0% left resets in 3h");
  });

  test("formats an empty usage response without throwing", () => {
    const snapshot = normalizeWhamUsageResponse({
      providerName: "chatgpt-plus-pro",
      nowMs: Date.parse("2026-06-18T12:00:00Z"),
      raw: {},
    });

    expect(
      formatChatGPTUsageSnapshot(snapshot, new Date("2026-06-18T12:00:00Z")),
    ).toBe("Usage: no active quota window reported");
  });

  test("normalizes the Codex WHAM usage payload shape", () => {
    const snapshot = normalizeWhamUsageResponse({
      providerName: "chatgpt-plus-pro",
      nowMs: Date.parse("2026-06-18T12:00:00Z"),
      raw: {
        plan_type: "pro",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 42,
            limit_window_seconds: 300,
            reset_after_seconds: 0,
            reset_at: 123,
          },
          secondary_window: {
            used_percent: 84,
            limit_window_seconds: 3600,
            reset_after_seconds: 0,
            reset_at: 456,
          },
        },
        additional_rate_limits: [
          {
            limit_name: "codex_other",
            metered_feature: "codex_other",
            rate_limit: {
              allowed: true,
              limit_reached: false,
              primary_window: {
                used_percent: 70,
                limit_window_seconds: 900,
                reset_after_seconds: 0,
                reset_at: 789,
              },
            },
          },
        ],
        credits: {
          has_credits: true,
          unlimited: false,
          balance: "9.99",
        },
        rate_limit_reset_credits: {
          available_count: 3,
        },
        spend_control: {
          reached: false,
          individual_limit: {
            limit: "25000",
            used: "8000",
            remaining: "17000",
            used_percent: 32,
            remaining_percent: 68,
            reset_after_seconds: 3600,
            reset_at: 789,
          },
        },
        rate_limit_reached_type: {
          type: "workspace_member_credits_depleted",
        },
      },
    });

    expect(snapshot.planType).toBe("pro");
    expect(snapshot.limitReached).toBe(false);
    expect(snapshot.rateLimitReachedType).toBe(
      "workspace_member_credits_depleted",
    );
    expect(snapshot.additional).toEqual([
      {
        label: "codex_other",
        usedPercent: 70,
        windowDurationMins: 15,
        resetsAt: 789,
      },
    ]);
    expect(snapshot.credits).toEqual({
      balance: "9.99",
      availableCount: 3,
      hasCredits: true,
      unlimited: false,
    });
    expect(snapshot.individualLimit).toEqual({
      limit: "25000",
      used: "8000",
      remainingPercent: 68,
      resetsAt: 789,
    });
  });

  test("reads api-target usage from the Letta Cloud provider endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = mock(
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return Response.json({
          providerName: "chatgpt-jin",
          fetchedAt: "2026-06-18T12:00:00.000Z",
          summary: "Usage: 5h 70% left resets in 2h",
          planType: "plus",
          limitReached: false,
          rateLimitReachedType: null,
          primary: {
            label: "primary",
            usedPercent: 30,
            windowDurationMins: 300,
            resetsAt: 1_781_791_200,
          },
          secondary: null,
          additional: [],
          credits: null,
          individualLimit: {
            limit: "80",
            used: "24",
            remainingPercent: 70,
            resetsAt: 1_781_791_200,
          },
        });
      },
    ) as unknown as typeof fetch;

    const result = await withEnv(
      { LETTA_API_KEY: undefined, LETTA_BASE_URL: undefined },
      () =>
        readChatGPTUsage({
          target: "api",
          providerName: "chatgpt-jin",
          forceRefresh: true,
          fetch: fetchMock,
          now: () => Date.parse("2026-06-18T12:00:00Z"),
          getSettings: async () => ({
            env: {
              LETTA_API_KEY: "letta-access-token",
              LETTA_BASE_URL: "https://api.test.letta.com",
            },
            refreshToken: undefined,
            tokenExpiresAt: undefined,
          }),
        }),
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error.message);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("Expected usage fetch to be called");
    expect(call.url).toBe(
      "https://api.test.letta.com/v1/providers/chatgpt-usage?provider_name=chatgpt-jin",
    );
    const headers = new Headers(call.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer letta-access-token");
    expect(result.usage.summary).toBe("Usage: 5h 70% left resets in 2h");
    expect(result.usage.individualLimit).toEqual({
      limit: "80",
      used: "24",
      remainingPercent: 70,
      resetsAt: 1_781_791_200,
    });
  });

  test("maps api-target cloud errors without falling back to local usage", async () => {
    const fetchMock = mock(async () =>
      Response.json({ message: "Provider not connected" }, { status: 404 }),
    ) as unknown as typeof fetch;

    const result = await withEnv(
      { LETTA_API_KEY: undefined, LETTA_BASE_URL: undefined },
      () =>
        readChatGPTUsage({
          target: "api",
          providerName: "chatgpt-missing",
          forceRefresh: true,
          fetch: fetchMock,
          getSettings: async () => ({
            env: {
              LETTA_API_KEY: "letta-access-token",
              LETTA_BASE_URL: "https://api.test.letta.com",
            },
            refreshToken: undefined,
            tokenExpiresAt: undefined,
          }),
        }),
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected cloud usage read to fail");
    expect(result.error).toEqual({
      code: "not_connected",
      message: "Provider not connected",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not treat a missing cloud usage endpoint as a disconnected provider", async () => {
    const fetchMock = mock(
      async () => new Response("Not Found", { status: 404 }),
    ) as unknown as typeof fetch;

    const result = await withEnv(
      { LETTA_API_KEY: undefined, LETTA_BASE_URL: undefined },
      () =>
        readChatGPTUsage({
          target: "api",
          providerName: "chatgpt-jin",
          forceRefresh: true,
          fetch: fetchMock,
          getSettings: async () => ({
            env: {
              LETTA_API_KEY: "letta-access-token",
              LETTA_BASE_URL: "https://api.test.letta.com",
            },
            refreshToken: undefined,
            tokenExpiresAt: undefined,
          }),
        }),
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected cloud usage read to fail");
    expect(result.error).toEqual({
      code: "network_error",
      message: "Letta Cloud ChatGPT usage endpoint is unavailable.",
    });
  });

  test("keeps the cloud usage timeout active while reading the response body", async () => {
    const fetchMock = mock(
      async (_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
        ({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new Error("aborted")),
              );
            }),
        }) as Response,
    ) as unknown as typeof fetch;

    const result = await withEnv(
      { LETTA_API_KEY: undefined, LETTA_BASE_URL: undefined },
      () =>
        readChatGPTUsage({
          target: "api",
          providerName: "chatgpt-jin",
          forceRefresh: true,
          fetch: fetchMock,
          timeoutMs: 1,
          getSettings: async () => ({
            env: {
              LETTA_API_KEY: "letta-access-token",
              LETTA_BASE_URL: "https://api.test.letta.com",
            },
            refreshToken: undefined,
            tokenExpiresAt: undefined,
          }),
        }),
    );

    expect(result).toEqual({
      success: false,
      error: {
        code: "network_error",
        message: "Letta Cloud ChatGPT usage request timed out.",
      },
    });
  });

  test("keeps the local WHAM timeout active while reading the response body", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "chatgpt-usage-timeout-"));
    try {
      setLocalOAuthProvider({
        storageDir,
        providerName: LOCAL_CHATGPT_PROVIDER_NAME,
        providerType: "chatgpt_oauth",
        auth: {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
          accountId: "account-id",
        },
      });

      const fetchMock = mock(
        async (_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
          ({
            ok: true,
            status: 200,
            json: () =>
              new Promise((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () =>
                  reject(new Error("aborted")),
                );
              }),
          }) as Response,
      ) as unknown as typeof fetch;

      const result = await readChatGPTUsage({
        target: "local",
        storageDir,
        fetch: fetchMock,
        timeoutMs: 1,
      });

      expect(result).toEqual({
        success: false,
        error: {
          code: "network_error",
          message: "ChatGPT usage request timed out.",
        },
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("isolates local usage caches by storage root and reuses the same account entry", async () => {
    const storageDirA = await mkdtemp(join(tmpdir(), "chatgpt-usage-a-"));
    const storageDirB = await mkdtemp(join(tmpdir(), "chatgpt-usage-b-"));
    try {
      for (const storageDir of [storageDirA, storageDirB]) {
        setLocalOAuthProvider({
          storageDir,
          providerName: LOCAL_CHATGPT_PROVIDER_NAME,
          providerType: "chatgpt_oauth",
          auth: {
            type: "oauth",
            access: "shared-storage-access",
            refresh: "shared-storage-refresh",
            expires: Date.now() + 60_000,
            accountId: "shared-storage-account",
          },
        });
      }

      const calls: string[] = [];
      const fetchMock = mock(
        async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const accountId = new Headers(init?.headers).get(
            "chatgpt-account-id",
          );
          calls.push(accountId ?? "missing");
          const usedPercent = calls.length === 1 ? 11 : 22;
          return Response.json({
            rate_limit: {
              primary_window: {
                used_percent: usedPercent,
              },
            },
          });
        },
      ) as unknown as typeof fetch;
      const now = Date.now();

      const firstA = await readChatGPTUsage({
        target: "local",
        storageDir: storageDirA,
        fetch: fetchMock,
        now: () => now,
      });
      const firstB = await readChatGPTUsage({
        target: "local",
        storageDir: storageDirB,
        fetch: fetchMock,
        now: () => now,
      });
      const secondA = await readChatGPTUsage({
        target: "local",
        storageDir: storageDirA,
        fetch: fetchMock,
        now: () => now,
      });

      expect(calls).toEqual([
        "shared-storage-account",
        "shared-storage-account",
      ]);
      expect(firstA.success && firstA.usage.primary?.usedPercent).toBe(11);
      expect(firstB.success && firstB.usage.primary?.usedPercent).toBe(22);
      expect(secondA).toEqual(firstA);
    } finally {
      await Promise.all(
        [storageDirA, storageDirB].map((dir) =>
          rm(dir, { recursive: true, force: true }),
        ),
      );
    }
  });

  test("isolates local usage caches when the OAuth account changes", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "chatgpt-account-swap-"));
    try {
      const setAccount = (accountId: string) =>
        setLocalOAuthProvider({
          storageDir,
          providerName: LOCAL_CHATGPT_PROVIDER_NAME,
          providerType: "chatgpt_oauth",
          auth: {
            type: "oauth",
            access: "shared-access-token",
            refresh: "shared-refresh-token",
            expires: Date.now() + 60_000,
            accountId,
          },
        });
      const accounts: string[] = [];
      const fetchMock = mock(
        async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const accountId =
            new Headers(init?.headers).get("chatgpt-account-id") ?? "missing";
          accounts.push(accountId);
          return Response.json({
            rate_limit: {
              primary_window: {
                used_percent: accountId === "oauth-account-a" ? 31 : 47,
              },
            },
          });
        },
      ) as unknown as typeof fetch;
      const now = Date.now();

      setAccount("oauth-account-a");
      const resultA = await readChatGPTUsage({
        target: "local",
        storageDir,
        fetch: fetchMock,
        now: () => now,
      });
      setAccount("oauth-account-b");
      const resultB = await readChatGPTUsage({
        target: "local",
        storageDir,
        fetch: fetchMock,
        now: () => now,
      });

      expect(accounts).toEqual(["oauth-account-a", "oauth-account-b"]);
      expect(resultA.success && resultA.usage.primary?.usedPercent).toBe(31);
      expect(resultB.success && resultB.usage.primary?.usedPercent).toBe(47);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("isolates cloud usage caches when credentials change", async () => {
    let apiKey = "cloud-credential-a";
    const authorizations: string[] = [];
    const fetchMock = mock(
      async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const authorization =
          new Headers(init?.headers).get("authorization") ?? "missing";
        authorizations.push(authorization);
        const usedPercent = authorization.endsWith("cloud-credential-a")
          ? 14
          : 28;
        return Response.json({
          providerName: "chatgpt-cache-test",
          fetchedAt: "2026-06-18T12:00:00.000Z",
          summary: `Usage: ${usedPercent}% used`,
          primary: {
            label: "primary",
            usedPercent,
            windowDurationMins: 300,
            resetsAt: null,
          },
          secondary: null,
          additional: [],
        });
      },
    ) as unknown as typeof fetch;
    const getSettings = async () => ({
      env: {
        LETTA_API_KEY: apiKey,
        LETTA_BASE_URL: "https://cache.test.letta.com",
      },
      refreshToken: undefined,
      tokenExpiresAt: undefined,
    });
    const now = Date.parse("2026-06-18T12:00:00Z");

    await withEnv(
      { LETTA_API_KEY: undefined, LETTA_BASE_URL: undefined },
      async () => {
        const resultA = await readChatGPTUsage({
          target: "api",
          providerName: "chatgpt-cache-test",
          fetch: fetchMock,
          getSettings,
          now: () => now,
        });
        apiKey = "cloud-credential-b";
        const resultB = await readChatGPTUsage({
          target: "api",
          providerName: "chatgpt-cache-test",
          fetch: fetchMock,
          getSettings,
          now: () => now,
        });
        const repeatedB = await readChatGPTUsage({
          target: "api",
          providerName: "chatgpt-cache-test",
          fetch: fetchMock,
          getSettings,
          now: () => now,
        });
        apiKey = "";
        const loggedOut = await readChatGPTUsage({
          target: "api",
          providerName: "chatgpt-cache-test",
          fetch: fetchMock,
          getSettings,
          now: () => now,
        });

        expect(resultA.success && resultA.usage.primary?.usedPercent).toBe(14);
        expect(resultB.success && resultB.usage.primary?.usedPercent).toBe(28);
        expect(repeatedB).toEqual(resultB);
        expect(loggedOut).toEqual({
          success: false,
          error: {
            code: "unauthorized",
            message: "Sign in with Letta to read ChatGPT usage.",
          },
        });
      },
    );

    expect(authorizations).toEqual([
      "Bearer cloud-credential-a",
      "Bearer cloud-credential-b",
    ]);
  });

  test("credential-scoped cache keys are stable without exposing identity inputs", () => {
    const rawCredential = "sk-sensitive-cloud-credential";
    const rawAccountId = "acct-sensitive-id";
    const rawStorageRoot = "/private/profile/alice";
    const identity = [rawStorageRoot, rawAccountId, rawCredential];
    const key = createCredentialScopedCacheKey("usage", identity);

    expect(createCredentialScopedCacheKey("usage", identity)).toBe(key);
    expect(
      createCredentialScopedCacheKey("usage", [
        rawStorageRoot,
        rawAccountId,
        "different-credential",
      ]),
    ).not.toBe(key);
    expect(key).not.toContain(rawCredential);
    expect(key).not.toContain(rawAccountId);
    expect(key).not.toContain(rawStorageRoot);
  });
});
