import { describe, expect, test } from "bun:test";
import Letta from "@letta-ai/letta-client";
import { clearAvailableModelsCache } from "@/agent/available-models";
import {
  formatPlanRotationNotice,
  isChatGPTPlanExhausted,
  rotateChatGPTPlanOnQuotaLimit,
} from "@/agent/chatgpt-plan-rotation";
import {
  parseChatGPTUsageLimitDetail,
  selectChatGPTQuotaFailoverHandle,
} from "@/agent/turn-recovery-policy";
import { __testSetBackend, APIBackend } from "@/backend";
import type { ChatGPTUsageSnapshot } from "@/providers/chatgpt-usage-service";

const FULL_DETAIL =
  'ChatGPT rate limit exceeded: {"error":{"type":"usage_limit_reached","message":"You have hit your usage limit.","plan_type":"plus","resets_at":1700000000,"resets_in_seconds":3600}}';

const PRIMARY_HANDLE = "chatgpt-caren/gpt-5.2";
const SIBLING_HANDLE = "chatgpt-jin/gpt-5.2";

describe("quota-aware plan rotation over HTTP", () => {
  for (const outcome of [
    "available",
    "all exhausted",
    "unavailable",
    "cancelled",
  ] as const) {
    test(`${outcome}: checks quota before updating only the active conversation`, async () => {
      const conversations = new Map([
        ["conv-first", PRIMARY_HANDLE],
        ["conv-second", PRIMARY_HANDLE],
      ]);
      const checked: string[] = [];
      const updates: string[] = [];
      const controller = new AbortController();
      const server = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          const path = url.pathname.replace(/\/$/, "");
          if (path === "/v1/models") {
            return Response.json(
              [PRIMARY_HANDLE, SIBLING_HANDLE, "chatgpt-third/gpt-5.2"].map(
                (handle) => ({
                  handle,
                  provider_type: "chatgpt_oauth",
                  provider_category: "byok",
                  max_context_window: 128_000,
                }),
              ),
            );
          }
          if (path === "/v1/providers/chatgpt-usage") {
            const provider = url.searchParams.get("provider_name") ?? "";
            checked.push(provider);
            if (outcome === "cancelled") controller.abort();
            if (outcome === "unavailable")
              return new Response("unavailable", { status: 503 });
            return Response.json({
              providerName: provider,
              fetchedAt: new Date().toISOString(),
              limitReached:
                outcome === "all exhausted" ||
                (outcome === "available" && checked.length === 1),
            });
          }
          const id = path.split("/").at(-1) ?? "";
          if (path === "/v1/agents/agent-rotation") {
            return Response.json({
              id,
              model: PRIMARY_HANDLE,
              llm_config: { context_window: 272_000 },
            });
          }
          if (path.startsWith("/v1/conversations/") && conversations.has(id)) {
            if (req.method === "PATCH") {
              return req.json().then((body) => {
                const model = (body as { model: string }).model;
                updates.push(model);
                conversations.set(id, model);
                return Response.json({ id, model });
              });
            }
            return Response.json({ id, model: conversations.get(id) });
          }
          return new Response("unexpected route", { status: 404 });
        },
      });
      const client = new Letta({
        apiKey: "test-key",
        baseURL: server.url.toString(),
        maxRetries: 0,
      });
      __testSetBackend(new APIBackend({ getClient: async () => client }));
      clearAvailableModelsCache();
      try {
        const result = await rotateChatGPTPlanOnQuotaLimit({
          agentId: "agent-rotation",
          conversationId: "conv-first",
          currentHandle: PRIMARY_HANDLE,
          error: { error_code: "usage_limit_reached" },
          exhaustedProviders: new Set(),
          signal: controller.signal,
        });
        if (outcome === "available") {
          expect(checked).toHaveLength(2);
          expect(result?.toProvider).toBe(checked[1]);
          expect(updates).toEqual([`${checked[1]}/gpt-5.2`]);
        } else if (outcome === "unavailable") {
          expect(checked).toHaveLength(1);
          expect(result?.toProvider).toBe(checked[0]);
          expect(updates).toHaveLength(1);
        } else {
          expect(checked).toHaveLength(outcome.startsWith("cancelled") ? 1 : 2);
          expect(result).toBeNull();
          expect(updates).toEqual([]);
          expect(conversations.get("conv-first")).toBe(PRIMARY_HANDLE);
        }
        expect(conversations.get("conv-second")).toBe(PRIMARY_HANDLE);
      } finally {
        server.stop(true);
        clearAvailableModelsCache();
        __testSetBackend(null);
      }
    });
  }
});

describe("plan-wide quota evidence", () => {
  const now = Date.now();
  const usage: ChatGPTUsageSnapshot = {
    providerName: "plan",
    fetchedAt: new Date(now).toISOString(),
    summary: "",
    primary: null,
    secondary: null,
    additional: [],
  };
  const fullWindow = {
    label: "primary",
    usedPercent: 100,
    windowDurationMins: 300,
    resetsAt: now / 1000 + 100,
  };

  test("uses the explicit limit verdict, including usable credits", () => {
    expect(isChatGPTPlanExhausted({ ...usage, limitReached: true }, now)).toBe(
      true,
    );
    expect(
      isChatGPTPlanExhausted(
        { ...usage, limitReached: false, primary: fullWindow },
        now,
      ),
    ).toBe(false);
    expect(
      isChatGPTPlanExhausted(
        { ...usage, primary: fullWindow, credits: { hasCredits: true } },
        now,
      ),
    ).toBe(false);
    expect(
      isChatGPTPlanExhausted(
        { ...usage, limitReached: true, credits: { hasCredits: true } },
        now,
      ),
    ).toBe(false);
  });

  test("uses unexpired primary/secondary windows, not unrelated model limits", () => {
    expect(isChatGPTPlanExhausted({ ...usage, primary: fullWindow }, now)).toBe(
      true,
    );
    expect(
      isChatGPTPlanExhausted({ ...usage, secondary: fullWindow }, now),
    ).toBe(true);
    expect(
      isChatGPTPlanExhausted(
        { ...usage, primary: { ...fullWindow, resetsAt: now / 1000 - 1 } },
        now,
      ),
    ).toBe(false);
    expect(
      isChatGPTPlanExhausted({ ...usage, additional: [fullWindow] }, now),
    ).toBe(false);
    expect(isChatGPTPlanExhausted(usage, now)).toBe(false);
  });

  test("does not exclude a plan from stale quota data", () => {
    expect(
      isChatGPTPlanExhausted(
        {
          ...usage,
          fetchedAt: new Date(now - 31_000).toISOString(),
          limitReached: true,
        },
        now,
      ),
    ).toBe(false);
  });
});

describe("rotateChatGPTPlanOnQuotaLimit", () => {
  interface UpdatePayload {
    model?: string;
    model_settings?: {
      reasoning?: { reasoning_effort?: string };
      reasoning_effort?: string;
      verbosity?: string;
      service_tier?: string | null;
    };
    context_window_limit?: number;
  }
  type Helpers = {
    conversationUpdates: { conversationId: string; payload: UpdatePayload }[];
    agentUpdates: UpdatePayload[];
  };
  function mockBackend(
    agent: { id: string; model: string },
    conversations: Map<
      string,
      { id: string; model: string | null } & Record<string, unknown>
    >,
  ) {
    const helpers: Helpers = { conversationUpdates: [], agentUpdates: [] };
    const backend = {
      capabilities: { localModelCatalog: false },
      async listModels() {
        return [
          {
            handle: PRIMARY_HANDLE,
            provider_type: "chatgpt_oauth",
            provider_category: "byok",
            max_context_window: 128_000,
          },
          {
            handle: SIBLING_HANDLE,
            provider_type: "chatgpt_oauth",
            provider_category: "byok",
            max_context_window: 128_000,
          },
        ];
      },
      async retrieveAgent() {
        return agent;
      },
      async updateAgent(_agentId: string, update: UpdatePayload) {
        helpers.agentUpdates.push(update);
        Object.assign(agent, update);
        return agent;
      },
      async retrieveConversation(conversationId: string) {
        return conversations.get(conversationId);
      },
      async updateConversation(conversationId: string, update: UpdatePayload) {
        const conversation = conversations.get(conversationId);
        if (!conversation) throw new Error("conversation not found");
        helpers.conversationUpdates.push({ conversationId, payload: update });
        Object.assign(conversation, update);
        return conversation;
      },
    };
    return { backend, helpers };
  }

  test("updates only the active conversation and keeps exhausted plans turn-local", async () => {
    const agent = {
      id: "agent-rotation",
      model: PRIMARY_HANDLE,
      llm_config: { context_window: 272_000 },
    };
    const conversations = new Map([
      ["conv-first", { id: "conv-first", model: PRIMARY_HANDLE }],
      ["conv-second", { id: "conv-second", model: PRIMARY_HANDLE }],
    ]);
    const { backend, helpers } = mockBackend(agent, conversations);
    __testSetBackend(backend as never);
    clearAvailableModelsCache();

    try {
      const firstTurnExhausted = new Set<string>();
      const secondTurnExhausted = new Set<string>();

      const firstRotation = await rotateChatGPTPlanOnQuotaLimit({
        agentId: "agent-rotation",
        conversationId: "conv-first",
        currentHandle: null,
        error: { error_code: "usage_limit_reached" },
        exhaustedProviders: firstTurnExhausted,
      });

      expect(firstRotation?.toHandle).toBe(SIBLING_HANDLE);
      expect(conversations.get("conv-first")?.model).toBe(SIBLING_HANDLE);
      expect(conversations.get("conv-second")?.model).toBe(PRIMARY_HANDLE);
      expect(agent.model).toBe(PRIMARY_HANDLE);
      expect(helpers.agentUpdates).toHaveLength(0);
      expect(firstTurnExhausted).toEqual(new Set(["chatgpt-caren"]));
      expect(secondTurnExhausted.size).toBe(0);

      const repeatedRotation = await rotateChatGPTPlanOnQuotaLimit({
        agentId: "agent-rotation",
        conversationId: "conv-first",
        // Simulate the TUI's render-time handle still naming the first plan.
        currentHandle: PRIMARY_HANDLE,
        error: { error_code: "usage_limit_reached" },
        exhaustedProviders: firstTurnExhausted,
      });

      expect(repeatedRotation).toBeNull();
      expect(firstTurnExhausted).toEqual(
        new Set(["chatgpt-caren", "chatgpt-jin"]),
      );

      const secondRotation = await rotateChatGPTPlanOnQuotaLimit({
        agentId: "agent-rotation",
        conversationId: "conv-second",
        currentHandle: null,
        error: { error_code: "usage_limit_reached" },
        exhaustedProviders: secondTurnExhausted,
      });

      expect(secondRotation?.toHandle).toBe(SIBLING_HANDLE);
      expect(secondTurnExhausted).toEqual(new Set(["chatgpt-caren"]));

      const defaultRotation = await rotateChatGPTPlanOnQuotaLimit({
        agentId: "agent-rotation",
        conversationId: "default",
        currentHandle: null,
        error: { error_code: "usage_limit_reached" },
        exhaustedProviders: new Set(),
      });

      expect(defaultRotation?.toHandle).toBe(SIBLING_HANDLE);
      expect(agent.model).toBe(SIBLING_HANDLE);
      expect(helpers.agentUpdates).toHaveLength(1);
      expect(helpers.agentUpdates[0]?.context_window_limit).toBe(272_000);
    } finally {
      clearAvailableModelsCache();
      __testSetBackend(null);
    }
  });

  for (const contextWindow of [128_000, 350_000, 543_210, 950_000]) {
    test(`preserves complete settings and the ${contextWindow} window`, async () => {
      const agent = {
        id: "agent-rotation",
        model: PRIMARY_HANDLE,
        model_settings: {
          provider_type: "chatgpt_oauth",
          parallel_tool_calls: true,
          reasoning: { reasoning_effort: "high" },
          verbosity: "low",
        },
        context_window_limit: 350_000,
      };
      const conversations = new Map([
        [
          "conv-first",
          {
            id: "conv-first",
            model: PRIMARY_HANDLE,
            model_settings: {
              provider_type: "chatgpt_oauth",
              parallel_tool_calls: false,
              reasoning: { reasoning_effort: "medium" },
              verbosity: "low",
              service_tier: null,
            },
            context_window_limit: contextWindow,
          },
        ],
      ]);
      const { backend, helpers } = mockBackend(agent, conversations);
      const originalSettings = structuredClone(
        conversations.get("conv-first")?.model_settings,
      );
      __testSetBackend(backend as never);
      clearAvailableModelsCache();

      try {
        const rotation = await rotateChatGPTPlanOnQuotaLimit({
          agentId: "agent-rotation",
          conversationId: "conv-first",
          currentHandle: null,
          error: { error_code: "usage_limit_reached" },
          exhaustedProviders: new Set(),
        });

        expect(rotation?.toHandle).toBe(SIBLING_HANDLE);
        expect(helpers.conversationUpdates).toHaveLength(1);
        const payload = helpers.conversationUpdates[0]?.payload;
        expect(payload?.model).toBe(SIBLING_HANDLE);
        // Account changes must not change the selected settings or window.
        expect(payload?.model_settings?.reasoning?.reasoning_effort).toBe(
          "medium",
        );
        expect(payload?.model_settings?.verbosity).toBe("low");
        expect(payload?.model_settings?.service_tier).toBeNull();
        expect(payload?.model_settings).toEqual(originalSettings);
        expect(payload?.context_window_limit).toBe(contextWindow);
      } finally {
        clearAvailableModelsCache();
        __testSetBackend(null);
      }
    });
  }

  test("inherits variant settings from the agent when the conversation has no override", async () => {
    const agent = {
      id: "agent-rotation",
      model: PRIMARY_HANDLE,
      model_settings: {
        provider_type: "chatgpt_oauth",
        reasoning: { reasoning_effort: "high" },
      },
      context_window_limit: 950_000,
      llm_config: { verbosity: "low", max_tokens: 4096 },
    };
    const conversations = new Map([
      ["conv-first", { id: "conv-first", model: null }],
    ]);
    const { backend, helpers } = mockBackend(agent, conversations);
    __testSetBackend(backend as never);
    clearAvailableModelsCache();

    try {
      const rotation = await rotateChatGPTPlanOnQuotaLimit({
        agentId: "agent-rotation",
        conversationId: "conv-first",
        currentHandle: null,
        error: { error_code: "usage_limit_reached" },
        exhaustedProviders: new Set(),
      });

      expect(rotation?.toHandle).toBe(SIBLING_HANDLE);
      const payload = helpers.conversationUpdates[0]?.payload;
      expect(payload?.model_settings?.reasoning?.reasoning_effort).toBe("high");
      expect(payload?.context_window_limit).toBe(950_000);
      expect(payload?.model_settings).toMatchObject({
        verbosity: "low",
        max_output_tokens: 4096,
      });
    } finally {
      clearAvailableModelsCache();
      __testSetBackend(null);
    }
  });

  test("does not inherit settings from an unrelated agent model", async () => {
    const agent = {
      id: "agent-rotation",
      model: "other/model",
      model_settings: { provider_type: "anthropic", effort: "high" },
      llm_config: { context_window: 543_210 },
    };
    const conversations = new Map([
      ["conv-first", { id: "conv-first", model: PRIMARY_HANDLE }],
    ]);
    const { backend, helpers } = mockBackend(agent, conversations);
    __testSetBackend(backend as never);
    clearAvailableModelsCache();
    try {
      expect(
        await rotateChatGPTPlanOnQuotaLimit({
          agentId: agent.id,
          conversationId: "conv-first",
          currentHandle: null,
          error: { error_code: "usage_limit_reached" },
          exhaustedProviders: new Set(),
        }),
      ).not.toBeNull();
      expect(helpers.conversationUpdates[0]?.payload).toEqual({
        model: SIBLING_HANDLE,
        model_settings: {},
        context_window_limit: 128_000,
      });
    } finally {
      clearAvailableModelsCache();
      __testSetBackend(null);
    }
  });

  test("does not rotate from a stale caller handle when state cannot be read", async () => {
    const { backend, helpers } = mockBackend(
      { id: "agent-rotation", model: PRIMARY_HANDLE },
      new Map(),
    );
    backend.retrieveAgent = async () => {
      throw new Error("unavailable");
    };
    __testSetBackend(backend as never);
    clearAvailableModelsCache();
    try {
      expect(
        await rotateChatGPTPlanOnQuotaLimit({
          agentId: "agent-rotation",
          conversationId: "conv-first",
          currentHandle: PRIMARY_HANDLE,
          error: { error_code: "usage_limit_reached" },
          exhaustedProviders: new Set(),
        }),
      ).toBeNull();
      expect(helpers.conversationUpdates).toEqual([]);
      expect(helpers.agentUpdates).toEqual([]);
    } finally {
      clearAvailableModelsCache();
      __testSetBackend(null);
    }
  });
});

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
