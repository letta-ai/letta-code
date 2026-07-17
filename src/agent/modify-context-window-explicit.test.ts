import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Backend } from "@/backend";
import { __testSetBackend } from "@/backend/backend";
import { clearAvailableModelsCache } from "./available-models";
import { preservableContextWindow } from "./model";
import { updateAgentLLMConfig, updateConversationLLMConfig } from "./modify";

/**
 * LET-9786: model-bearing agent/conversation updates must ALWAYS carry an
 * explicit context_window_limit on API backends (contextWindowOverride wins,
 * then updateArgs.context_window, then the models API, then the registry
 * preset, then the current server value re-sent as-is).
 *
 * The server treats an omitted context_window_limit as "re-derive the
 * llm_config from the handle", which clamps the context window to a legacy
 * global default (128k) regardless of the model's real window. The old
 * `avoidOverwritingExistingContextWindow` option omitted the field to
 * "preserve" the current value — the server then re-clamped it, silently
 * poisoning agents to 128k and keeping them there (the poisoned value looks
 * like a user customization, so it kept being "preserved" by omission).
 */

type UpdateCall = { id: string; body: Record<string, unknown> };

function makeBackend(opts?: {
  localModelCatalog?: boolean;
  listedModels?: Array<Record<string, unknown>>;
  currentContextWindow?: number;
  /**
   * When set, the conversation record has NO context_window_limit of its own
   * (it inherits from the agent); the agent's llm_config carries this value.
   */
  agentInheritedContextWindow?: number;
}) {
  const calls = {
    updateAgent: [] as UpdateCall[],
    updateConversation: [] as UpdateCall[],
  };
  const agentContextWindow =
    opts?.agentInheritedContextWindow ?? opts?.currentContextWindow;
  const backend = {
    capabilities: { localModelCatalog: opts?.localModelCatalog ?? false },
    listModels: async () =>
      opts?.listedModels ?? [
        {
          handle: "openai/gpt-5.6-sol",
          max_context_window: 350000,
          provider_type: "openai",
        },
      ],
    updateAgent: async (id: string, body: Record<string, unknown>) => {
      calls.updateAgent.push({ id, body });
      return {};
    },
    updateConversation: async (id: string, body: Record<string, unknown>) => {
      calls.updateConversation.push({ id, body });
      return {};
    },
    retrieveAgent: async () => ({
      id: "agent-1",
      llm_config:
        agentContextWindow !== undefined
          ? { context_window: agentContextWindow }
          : {},
    }),
    retrieveConversation: async () => ({
      id: "conv-1",
      agent_id: "agent-1",
      context_window_limit:
        opts?.agentInheritedContextWindow !== undefined
          ? null
          : (opts?.currentContextWindow ?? null),
    }),
  } as unknown as Backend;
  return { backend, calls };
}

function useBackend(opts?: Parameters<typeof makeBackend>[0]) {
  const { backend, calls } = makeBackend(opts);
  __testSetBackend(backend);
  clearAvailableModelsCache();
  return calls;
}

let currentCalls: ReturnType<typeof makeBackend>["calls"];

beforeEach(() => {
  currentCalls = useBackend();
});

afterEach(() => {
  __testSetBackend(null);
  clearAvailableModelsCache();
});

describe("model updates always send an explicit context_window_limit", () => {
  test("agent update without updateArgs.context_window derives it from the models API", async () => {
    await updateAgentLLMConfig("agent-1", "openai/gpt-5.6-sol", {
      reasoning_effort: "high",
    });
    expect(currentCalls.updateAgent).toHaveLength(1);
    expect(currentCalls.updateAgent[0]?.body.context_window_limit).toBe(350000);
  });

  test("agent update honors an explicit updateArgs.context_window (preset)", async () => {
    await updateAgentLLMConfig("agent-1", "openai/gpt-5.6-sol", {
      reasoning_effort: "high",
      context_window: 1050000,
    });
    expect(currentCalls.updateAgent).toHaveLength(1);
    expect(currentCalls.updateAgent[0]?.body.context_window_limit).toBe(
      1050000,
    );
  });

  test("contextWindowOverride wins over preset and catalog", async () => {
    await updateAgentLLMConfig(
      "agent-1",
      "openai/gpt-5.6-sol",
      { reasoning_effort: "high", context_window: 350000 },
      { contextWindowOverride: 1050000 },
    );
    expect(currentCalls.updateAgent[0]?.body.context_window_limit).toBe(
      1050000,
    );
  });

  test("conversation update without updateArgs.context_window derives it from the models API", async () => {
    await updateConversationLLMConfig("conv-1", "openai/gpt-5.6-sol", {
      reasoning_effort: "high",
    });
    expect(currentCalls.updateConversation).toHaveLength(1);
    expect(currentCalls.updateConversation[0]?.body.context_window_limit).toBe(
      350000,
    );
  });

  test("conversation update honors contextWindowOverride", async () => {
    await updateConversationLLMConfig(
      "conv-1",
      "openai/gpt-5.6-sol",
      { reasoning_effort: "high", context_window: 350000 },
      { contextWindowOverride: 1050000 },
    );
    expect(currentCalls.updateConversation[0]?.body.context_window_limit).toBe(
      1050000,
    );
  });

  test("known handle absent from the models API falls back to the registry preset", async () => {
    // Review P1: an empty models listing must not cause omission.
    currentCalls = useBackend({ listedModels: [] });
    await updateAgentLLMConfig("agent-1", "openai/gpt-5.6-sol", {
      reasoning_effort: "high",
    });
    // gpt-5.6-sol registry preset (base variant) context window.
    expect(currentCalls.updateAgent[0]?.body.context_window_limit).toBeNumber();
  });

  test("uncatalogued custom handle re-sends the current server value instead of omitting", async () => {
    // Review P1: custom/BYOK handle with no models-API entry and no registry
    // preset — the last resort is re-sending the entity's current value.
    currentCalls = useBackend({
      listedModels: [],
      currentContextWindow: 200000,
    });
    await updateAgentLLMConfig("agent-1", "custom-provider/my-model", {
      reasoning_effort: "high",
    });
    expect(currentCalls.updateAgent[0]?.body.context_window_limit).toBe(200000);

    await updateConversationLLMConfig("conv-1", "custom-provider/my-model", {
      reasoning_effort: "high",
    });
    expect(currentCalls.updateConversation[0]?.body.context_window_limit).toBe(
      200000,
    );
  });

  test("conversation inheriting its window from the agent walks up to the agent value", async () => {
    // Re-review P1: conversation record has context_window_limit null (no
    // override); the fallback must fetch the agent's value, not omit.
    currentCalls = useBackend({
      listedModels: [],
      agentInheritedContextWindow: 200000,
    });
    await updateConversationLLMConfig("conv-1", "custom-provider/my-model", {
      reasoning_effort: "high",
    });
    expect(currentCalls.updateConversation[0]?.body.context_window_limit).toBe(
      200000,
    );
  });
});

describe("local backends (localModelCatalog)", () => {
  test("contextWindowOverride is honored even when the local catalog owns token limits", async () => {
    // Review P1 (local): preserve paths must not be discarded by the
    // local-catalog gate that ignores updateArgs.context_window.
    currentCalls = useBackend({ localModelCatalog: true, listedModels: [] });
    await updateAgentLLMConfig(
      "agent-1",
      "openrouter/some/model",
      { reasoning_effort: "high", context_window: 350000 },
      { contextWindowOverride: 123456 },
    );
    expect(currentCalls.updateAgent[0]?.body.context_window_limit).toBe(123456);
  });

  test("without an override, local backends omit the field (no clamp exists locally)", async () => {
    currentCalls = useBackend({ localModelCatalog: true, listedModels: [] });
    await updateAgentLLMConfig("agent-1", "openrouter/some/model", {
      reasoning_effort: "high",
      context_window: 350000,
    });
    expect(
      currentCalls.updateAgent[0]?.body.context_window_limit,
    ).toBeUndefined();
  });
});

describe("preservableContextWindow (server-clamp poison filter)", () => {
  test("preserves normal custom values", () => {
    expect(preservableContextWindow(272000, "openai/gpt-5.6-sol")).toBe(272000);
    expect(preservableContextWindow(1050000, "openai/gpt-5.6-sol")).toBe(
      1050000,
    );
  });

  test("rejects a 128k value that matches no preset for the handle (poison)", () => {
    // Review P2: same-variant tier changes must not re-send the server
    // clamp value for models whose presets never include 128000.
    expect(
      preservableContextWindow(128000, "openai/gpt-5.6-sol"),
    ).toBeUndefined();
    expect(
      preservableContextWindow(128000, "anthropic/claude-opus-4-8"),
    ).toBeUndefined();
  });

  test("keeps 128k for models whose registry presets legitimately use it", () => {
    // gpt-5.3-codex-spark presets are 128000 — a matching value is a real
    // preset, not poison.
    expect(
      preservableContextWindow(128000, "chatgpt-plus-pro/gpt-5.3-codex-spark"),
    ).toBe(128000);
  });

  test("rejects non-positive and missing values", () => {
    expect(preservableContextWindow(0, "openai/gpt-5.6-sol")).toBeUndefined();
    expect(
      preservableContextWindow(null, "openai/gpt-5.6-sol"),
    ).toBeUndefined();
    expect(
      preservableContextWindow(undefined, "openai/gpt-5.6-sol"),
    ).toBeUndefined();
  });
});
