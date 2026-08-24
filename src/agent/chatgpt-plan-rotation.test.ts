import { describe, expect, test } from "bun:test";
import { formatPlanRotationNotice } from "@/agent/chatgpt-plan-rotation";
import {
  parseChatGPTUsageLimitDetail,
  selectChatGPTQuotaFailoverHandle,
} from "@/agent/turn-recovery-policy";

const FULL_DETAIL =
  'ChatGPT rate limit exceeded: {"error":{"type":"usage_limit_reached","message":"You have hit your usage limit.","plan_type":"plus","resets_at":1700000000,"resets_in_seconds":3600}}';

describe("parseChatGPTUsageLimitDetail", () => {
  test("returns null for non-strings and non-matching details", () => {
    expect(parseChatGPTUsageLimitDetail(undefined)).toBeNull();
    expect(parseChatGPTUsageLimitDetail({})).toBeNull();
    expect(parseChatGPTUsageLimitDetail("Anthropic API error")).toBeNull();
    expect(
      parseChatGPTUsageLimitDetail("ChatGPT rate limit exceeded: {}"),
    ).toBeNull();
  });

  test("parses the full nested JSON shape (resets_at wins, unix s → ms)", () => {
    expect(parseChatGPTUsageLimitDetail(FULL_DETAIL)).toEqual({
      planType: "plus",
      resetsAt: 1700000000 * 1000,
    });
  });

  test("matches usage_limit_reached case-insensitively", () => {
    expect(
      parseChatGPTUsageLimitDetail(
        'error: {"error":{"type":"USAGE_LIMIT_REACHED"}}',
      ),
    ).toEqual({ planType: null, resetsAt: null });
  });

  test("parses structured Cloud error fields", () => {
    expect(
      parseChatGPTUsageLimitDetail({
        detail: "ChatGPT rate limit exceeded:",
        error_code: "usage_limit_reached",
      }),
    ).toEqual({ planType: null, resetsAt: null });
    expect(
      parseChatGPTUsageLimitDetail({
        raw: {
          error: {
            type: "usage_limit_reached",
            plan_type: "pro",
            resets_at: 1787803152,
          },
        },
      }),
    ).toEqual({ planType: "pro", resetsAt: 1787803152 * 1000 });
  });

  test("falls back to resets_in_seconds when resets_at is absent", () => {
    const before = Date.now();
    const parsed = parseChatGPTUsageLimitDetail(
      'ChatGPT rate limit exceeded: {"error":{"type":"usage_limit_reached","resets_in_seconds":600}}',
    );
    expect(parsed?.resetsAt ?? 0).toBeGreaterThanOrEqual(before + 600_000);
    expect(parsed?.resetsAt ?? 0).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  test("tolerates missing reset fields, malformed JSON, and no JSON blob", () => {
    const empty = { planType: null, resetsAt: null };
    expect(
      parseChatGPTUsageLimitDetail(
        'ChatGPT rate limit exceeded: {"error":{"type":"usage_limit_reached"}}',
      ),
    ).toEqual(empty);
    expect(
      parseChatGPTUsageLimitDetail(
        "ChatGPT rate limit exceeded: {usage_limit_reached not-json",
      ),
    ).toEqual(empty);
    expect(
      parseChatGPTUsageLimitDetail("provider says usage_limit_reached"),
    ).toEqual(empty);
  });
});

describe("selectChatGPTQuotaFailoverHandle", () => {
  const chatgpt = (provider: string, model: string) => ({
    handle: `${provider}/${model}`,
    providerType: "chatgpt_oauth",
    providerCategory: "byok",
  });

  const models = [
    chatgpt("chatgpt-caren", "gpt-5.2"),
    chatgpt("chatgpt-caren", "gpt-5.2-codex"),
    chatgpt("chatgpt-jin", "gpt-5.2"),
    chatgpt("chatgpt-jin", "gpt-5.2-codex"),
    chatgpt("chatgpt-mia", "gpt-5.2"),
    {
      handle: "openai/gpt-5.2",
      providerType: "openai",
      providerCategory: "byok",
    },
    {
      handle: "anthropic/claude-sonnet-4-5",
      providerType: "anthropic",
      providerCategory: "base",
    },
  ];

  const select = (
    currentHandle: string,
    exhausted: string[] = [],
    random?: () => number,
  ) =>
    selectChatGPTQuotaFailoverHandle({
      currentHandle,
      models,
      exhaustedProviders: new Set(exhausted),
      random,
    });

  test("returns null when current handle is not a chatgpt_oauth byok model", () => {
    expect(select("openai/gpt-5.2")).toBeNull();
    expect(select("anthropic/claude-sonnet-4-5")).toBeNull();
    expect(select("chatgpt-unknown/gpt-5.2")).toBeNull();
    expect(select("gpt-5.2")).toBeNull();
  });

  test("only matches siblings with the same model suffix", () => {
    // chatgpt-mia has no gpt-5.2-codex, so jin is the only candidate
    expect(select("chatgpt-caren/gpt-5.2-codex", [], () => 0)).toBe(
      "chatgpt-jin/gpt-5.2-codex",
    );
  });

  test("excludes exhausted providers and returns null when all are exhausted", () => {
    expect(select("chatgpt-caren/gpt-5.2", ["chatgpt-jin"], () => 0)).toBe(
      "chatgpt-mia/gpt-5.2",
    );
    expect(
      select("chatgpt-caren/gpt-5.2", ["chatgpt-jin", "chatgpt-mia"]),
    ).toBeNull();
  });

  test("injected random picks deterministically among chatgpt siblings only", () => {
    expect(select("chatgpt-caren/gpt-5.2", [], () => 0)).toBe(
      "chatgpt-jin/gpt-5.2",
    );
    expect(select("chatgpt-caren/gpt-5.2", [], () => 0.999)).toBe(
      "chatgpt-mia/gpt-5.2",
    );
  });
});

describe("formatPlanRotationNotice", () => {
  test("includes reset time when known, omits it when null", () => {
    const withReset = formatPlanRotationNotice({
      fromProvider: "chatgpt-caren",
      toProvider: "chatgpt-jin",
      resetsAt: new Date(2024, 0, 1, 15, 40).getTime(),
    });
    expect(withReset).toContain("chatgpt-caren hit its usage limit");
    expect(withReset).toContain("resets");
    expect(withReset).toContain("switched to chatgpt-jin");

    expect(
      formatPlanRotationNotice({
        fromProvider: "chatgpt-caren",
        toProvider: "chatgpt-jin",
        resetsAt: null,
      }),
    ).toBe("chatgpt-caren hit its usage limit — switched to chatgpt-jin");
  });
});
