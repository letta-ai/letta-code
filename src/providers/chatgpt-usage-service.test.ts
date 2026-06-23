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
});
