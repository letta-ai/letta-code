import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Backend } from "@/backend";
import { __testSetBackend } from "@/backend/backend";
import { clearAvailableModelsCache } from "./available-models";
import { updateAgentLLMConfig, updateConversationLLMConfig } from "./modify";

/**
 * LET-9786: model-bearing agent/conversation updates must ALWAYS carry an
 * explicit context_window_limit (from updateArgs.context_window when the
 * caller preserves/overrides, otherwise derived from the models API).
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

function makeBackend() {
  const calls = {
    updateAgent: [] as UpdateCall[],
    updateConversation: [] as UpdateCall[],
  };
  const backend = {
    capabilities: { localModelCatalog: false },
    listModels: async () => [
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
    retrieveAgent: async () => ({ id: "agent-1", llm_config: {} }),
  } as unknown as Backend;
  return { backend, calls };
}

let currentCalls: ReturnType<typeof makeBackend>["calls"];

beforeEach(() => {
  const { backend, calls } = makeBackend();
  __testSetBackend(backend);
  clearAvailableModelsCache();
  currentCalls = calls;
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

  test("agent update honors an explicit updateArgs.context_window (preserve = re-send)", async () => {
    await updateAgentLLMConfig("agent-1", "openai/gpt-5.6-sol", {
      reasoning_effort: "high",
      context_window: 1050000,
    });
    expect(currentCalls.updateAgent).toHaveLength(1);
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

  test("conversation update honors an explicit updateArgs.context_window", async () => {
    await updateConversationLLMConfig("conv-1", "openai/gpt-5.6-sol", {
      reasoning_effort: "high",
      context_window: 1050000,
    });
    expect(currentCalls.updateConversation).toHaveLength(1);
    expect(currentCalls.updateConversation[0]?.body.context_window_limit).toBe(
      1050000,
    );
  });
});
