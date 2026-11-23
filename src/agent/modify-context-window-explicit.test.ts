import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Backend } from "@/backend";
import { __testSetBackend } from "@/backend/backend";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";
import { clearAvailableModelsCache } from "./available-models";
import { preservableContextWindow } from "./model";
import { updateAgentLLMConfig, updateConversationLLMConfig } from "./modify";

type UpdateCall = { id: string; body: Record<string, unknown> };

function makeBackend(opts?: {
  localModelCatalog?: boolean;
  listedModels?: Array<Record<string, unknown>>;
  currentContextWindow?: number;
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

setupRuntimeModelCatalogFixture();
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
    currentCalls = useBackend({ listedModels: [] });
    await updateAgentLLMConfig("agent-1", "openai/gpt-5.6-sol", {
      reasoning_effort: "high",
    });
    expect(currentCalls.updateAgent[0]?.body.context_window_limit).toBeNumber();
  });

  test("uncatalogued custom handle re-sends the current server value instead of omitting", async () => {
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
    expect(
      preservableContextWindow(128000, "openai/gpt-5.6-sol"),
    ).toBeUndefined();
    expect(
      preservableContextWindow(128000, "anthropic/claude-opus-4-8"),
    ).toBeUndefined();
  });

  test("keeps 128k for models whose registry presets legitimately use it", () => {
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
