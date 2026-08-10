import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLocalOAuthProvider } from "@/backend/local/local-provider-auth-store";
import {
  consumeChatGPTRateLimitResetCredit,
  readChatGPTRateLimitResetCredits,
} from "@/providers/chatgpt-reset-credit-service";

async function withEnv<T>(
  updates: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(
    Object.keys(updates).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function connectLocalProvider(input: {
  storageDir: string;
  providerName: string;
}): void {
  setLocalOAuthProvider({
    storageDir: input.storageDir,
    providerName: input.providerName,
    providerType: "chatgpt_oauth",
    auth: {
      type: "oauth",
      access: "chatgpt-access-token",
      refresh: "chatgpt-refresh-token",
      expires: Date.now() + 60_000,
      accountId: "chatgpt-account-1",
    },
  });
}

function resetCreditsResponse(availableCount: number): Response {
  return Response.json({
    available_count: availableCount,
    credits:
      availableCount > 0
        ? [
            {
              id: "RateLimitResetCredit_1",
              reset_type: "codex_rate_limits",
              status: "available",
              granted_at: "2026-08-01T00:00:00Z",
              expires_at: "2026-09-01T00:00:00Z",
              title: "Full reset",
              description: "Ready to redeem",
            },
          ]
        : [],
  });
}

describe("ChatGPT reset-credit service", () => {
  test("lists local reset credits with refreshed OAuth request credentials", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "chatgpt-reset-local-"));
    const providerName = "chatgpt-reset-local-list";
    try {
      connectLocalProvider({ storageDir, providerName });
      const fetchSpy = mock(async (..._args: Parameters<typeof fetch>) =>
        resetCreditsResponse(1),
      );
      const fetchMock = fetchSpy as unknown as typeof fetch;

      const result = await readChatGPTRateLimitResetCredits({
        target: "local",
        providerName,
        storageDir,
        forceRefresh: true,
        now: () => Date.parse("2026-08-06T12:00:00Z"),
        fetch: fetchMock,
      });

      expect(result).toEqual({
        success: true,
        credits: {
          providerName,
          fetchedAt: "2026-08-06T12:00:00.000Z",
          availableCount: 1,
          credits: [
            {
              id: "RateLimitResetCredit_1",
              resetType: "codex_rate_limits",
              status: "available",
              grantedAt: "2026-08-01T00:00:00Z",
              expiresAt: "2026-09-01T00:00:00Z",
              title: "Full reset",
              description: "Ready to redeem",
            },
          ],
        },
      });
      const call = fetchSpy.mock.calls[0];
      expect(String(call?.[0])).toBe(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
      );
      const headers = new Headers(call?.[1]?.headers);
      expect(headers.get("authorization")).toBe("Bearer chatgpt-access-token");
      expect(headers.get("chatgpt-account-id")).toBe("chatgpt-account-1");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("lists API-stored reset credits through Letta Cloud and caches them", async () => {
    const fetchSpy = mock(async (..._args: Parameters<typeof fetch>) =>
      Response.json({
        providerName: "chatgpt-reset-cloud-list",
        fetchedAt: "2026-08-06T12:00:00.000Z",
        availableCount: 1,
        credits: [
          {
            id: "RateLimitResetCredit_1",
            resetType: "codex_rate_limits",
            status: "available",
            grantedAt: "2026-08-01T00:00:00Z",
            expiresAt: null,
            title: null,
            description: null,
          },
        ],
      }),
    );
    const fetchMock = fetchSpy as unknown as typeof fetch;
    const input = {
      target: "api" as const,
      providerName: "chatgpt-reset-cloud-list",
      fetch: fetchMock,
      now: () => Date.parse("2026-08-06T12:00:00Z"),
      getSettings: async () => ({
        env: {
          LETTA_API_KEY: "letta-access-token",
          LETTA_BASE_URL: "https://api.test.letta.com",
        },
        refreshToken: undefined,
        tokenExpiresAt: undefined,
      }),
    };

    const [first, second] = await withEnv(
      { LETTA_API_KEY: undefined, LETTA_BASE_URL: undefined },
      async () => [
        await readChatGPTRateLimitResetCredits(input),
        await readChatGPTRateLimitResetCredits(input),
      ],
    );

    expect(first).toEqual(second);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    expect(String(call?.[0])).toBe(
      "https://api.test.letta.com/v1/providers/chatgpt-rate-limit-reset-credits?provider_name=chatgpt-reset-cloud-list",
    );
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer letta-access-token");
  });

  test("passes the same idempotency key and selected reset ID to Cloud", async () => {
    const fetchSpy = mock(async (...args: Parameters<typeof fetch>) => {
      const [url] = args;
      const value = String(url);
      if (value.endsWith("/consume")) {
        return Response.json({ outcome: "no_credit" });
      }
      throw new Error(`Unexpected URL ${value}`);
    });
    const fetchMock = fetchSpy as unknown as typeof fetch;

    const result = await withEnv(
      { LETTA_API_KEY: undefined, LETTA_BASE_URL: undefined },
      () =>
        consumeChatGPTRateLimitResetCredit({
          target: "api",
          providerName: "chatgpt-reset-cloud-consume",
          idempotencyKey: "redeem-request-1",
          resetId: "RateLimitResetCredit_1",
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

    expect(result).toEqual({ success: true, outcome: "no_credit" });
    const call = fetchSpy.mock.calls[0];
    expect(String(call?.[0])).toBe(
      "https://api.test.letta.com/v1/providers/chatgpt-rate-limit-reset-credits/consume",
    );
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      provider_name: "chatgpt-reset-cloud-consume",
      idempotency_key: "redeem-request-1",
      reset_id: "RateLimitResetCredit_1",
    });
  });

  test("refreshes usage and reset inventory after a successful local reset", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "chatgpt-reset-refresh-"));
    const providerName = "chatgpt-reset-local-refresh";
    let listReads = 0;
    try {
      connectLocalProvider({ storageDir, providerName });
      const fetchMock = mock(async (url: Parameters<typeof fetch>[0]) => {
        const value = String(url);
        if (value.endsWith("/consume")) {
          return Response.json({ code: "reset", windows_reset: 2 });
        }
        if (value.endsWith("/wham/usage")) {
          return Response.json({
            plan_type: "pro",
            rate_limit: {
              limit_reached: false,
              primary_window: {
                used_percent: 0,
                limit_window_seconds: 18_000,
                reset_after_seconds: 18_000,
              },
            },
          });
        }
        if (value.endsWith("/rate-limit-reset-credits")) {
          listReads += 1;
          return resetCreditsResponse(listReads === 1 ? 1 : 0);
        }
        throw new Error(`Unexpected URL ${value}`);
      }) as unknown as typeof fetch;
      const sharedInput = {
        target: "local" as const,
        providerName,
        storageDir,
        fetch: fetchMock,
        now: () => Date.parse("2026-08-06T12:00:00Z"),
      };

      const before = await readChatGPTRateLimitResetCredits(sharedInput);
      expect(before.success && before.credits.availableCount).toBe(1);

      const consumed = await consumeChatGPTRateLimitResetCredit({
        ...sharedInput,
        idempotencyKey: "redeem-refresh-1",
      });

      expect(consumed.success).toBe(true);
      if (!consumed.success) throw new Error(consumed.error.message);
      expect(consumed.outcome).toBe("reset");
      expect(consumed.refreshedUsage?.limitReached).toBe(false);
      expect(consumed.refreshedCredits?.availableCount).toBe(0);
      expect(consumed.refreshError).toBeUndefined();
      expect(listReads).toBe(2);

      const after = await readChatGPTRateLimitResetCredits(sharedInput);
      expect(after.success && after.credits.availableCount).toBe(0);
      expect(listReads).toBe(2);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("treats already_redeemed as idempotent success and refreshes state", async () => {
    const readUsage = mock(async () => ({
      success: true as const,
      usage: {
        providerName: "chatgpt-reset-idempotent",
        fetchedAt: "2026-08-06T12:00:00.000Z",
        summary: "Usage: no active quota window reported",
        primary: null,
        secondary: null,
        additional: [],
      },
    }));
    let listCalls = 0;
    const fetchMock = mock(async (url: Parameters<typeof fetch>[0]) => {
      const value = String(url);
      if (value.endsWith("/consume")) {
        return Response.json({ outcome: "already_redeemed" });
      }
      listCalls += 1;
      return Response.json({
        providerName: "chatgpt-reset-idempotent",
        fetchedAt: "2026-08-06T12:00:00.000Z",
        availableCount: 0,
        credits: [],
      });
    }) as unknown as typeof fetch;

    const result = await withEnv(
      { LETTA_API_KEY: undefined, LETTA_BASE_URL: undefined },
      () =>
        consumeChatGPTRateLimitResetCredit({
          target: "api",
          providerName: "chatgpt-reset-idempotent",
          idempotencyKey: "redeem-idempotent-1",
          fetch: fetchMock,
          readUsage,
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

    expect(result.success && result.outcome).toBe("already_redeemed");
    expect(readUsage).toHaveBeenCalledTimes(1);
    expect(listCalls).toBe(1);
  });

  test("does not refresh state for non-success consume outcomes", async () => {
    const readUsage = mock(async () => {
      throw new Error("usage refresh must not run");
    });
    const fetchMock = mock(async () =>
      Response.json({ outcome: "nothing_to_reset" }),
    ) as unknown as typeof fetch;

    const result = await withEnv(
      { LETTA_API_KEY: undefined, LETTA_BASE_URL: undefined },
      () =>
        consumeChatGPTRateLimitResetCredit({
          target: "api",
          providerName: "chatgpt-reset-nothing",
          idempotencyKey: "redeem-nothing-1",
          fetch: fetchMock,
          readUsage,
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

    expect(result).toEqual({ success: true, outcome: "nothing_to_reset" });
    expect(readUsage).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("rejects an empty idempotency key before any request", async () => {
    const fetchMock = mock(async () =>
      resetCreditsResponse(1),
    ) as unknown as typeof fetch;

    const result = await consumeChatGPTRateLimitResetCredit({
      target: "api",
      providerName: "chatgpt-reset-empty-key",
      idempotencyKey: " ",
      fetch: fetchMock,
    });

    expect(result).toEqual({
      success: false,
      error: {
        code: "bad_request",
        message: "An idempotency key is required to consume a reset credit.",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
