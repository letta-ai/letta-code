import { describe, expect, test } from "bun:test";
import type { Backend } from "@/backend";
import { type ModelConfigTarget, updateModelConfig } from "./modify";

type UpdateCall = { id: string; body: Record<string, unknown> };

function makeBackend(opts?: {
  localModelCatalog?: boolean;
  agentModel?: string;
  conversationModel?: string | null;
}) {
  const calls = {
    updateAgent: [] as UpdateCall[],
    updateConversation: [] as UpdateCall[],
    retrieveAgent: 0,
    retrieveConversation: 0,
  };
  const backend = {
    capabilities: { localModelCatalog: opts?.localModelCatalog ?? false },
    retrieveAgent: async () => {
      calls.retrieveAgent += 1;
      return {
        model: opts?.agentModel ?? "anthropic/claude-opus-4-8",
        llm_config: {},
      };
    },
    retrieveConversation: async () => {
      calls.retrieveConversation += 1;
      return { model: opts?.conversationModel ?? null };
    },
    updateAgent: async (id: string, body: Record<string, unknown>) => {
      calls.updateAgent.push({ id, body });
      return {};
    },
    updateConversation: async (id: string, body: Record<string, unknown>) => {
      calls.updateConversation.push({ id, body });
      return {};
    },
  } as unknown as Backend;
  return { backend, calls };
}

const conversationTarget: ModelConfigTarget = {
  scope: "conversation",
  conversationId: "conv-1",
  agentId: "agent-1",
};

describe("updateModelConfig", () => {
  test("context-window-only sends just context_window_limit, preserving model/settings", async () => {
    const { backend, calls } = makeBackend();
    await updateModelConfig(backend, conversationTarget, {
      contextWindow: 200000,
    });
    expect(calls.updateConversation).toHaveLength(1);
    expect(calls.updateConversation[0]?.body).toEqual({
      context_window_limit: 200000,
    });
    // No model resolution needed when only the context window changes.
    expect(calls.retrieveConversation).toBe(0);
    expect(calls.retrieveAgent).toBe(0);
  });

  test("reasoning-effort-only resolves the current model and rebuilds settings", async () => {
    const { backend, calls } = makeBackend({
      agentModel: "anthropic/claude-opus-4-8",
    });
    await updateModelConfig(backend, conversationTarget, {
      reasoningEffort: "high",
    });
    expect(calls.updateConversation).toHaveLength(1);
    const body = calls.updateConversation[0]?.body ?? {};
    expect(body.model).toBeUndefined();
    expect(body.context_window_limit).toBeUndefined();
    expect((body.model_settings as { effort?: string }).effort).toBe("high");
    // Conversation has no override, so it falls back to the agent's model.
    expect(calls.retrieveAgent).toBe(1);
  });

  test("model change rebuilds settings and honors an explicit context window", async () => {
    const { backend, calls } = makeBackend();
    await updateModelConfig(backend, conversationTarget, {
      model: "openai/gpt-5.5",
      reasoningEffort: "max",
      contextWindow: 400000,
    });
    expect(calls.updateConversation).toHaveLength(1);
    const body = calls.updateConversation[0]?.body ?? {};
    expect(body.model).toBe("openai/gpt-5.5");
    expect(body.context_window_limit).toBe(400000);
    expect(body.model_settings).toBeDefined();
    // Model supplied explicitly, so no lookup of the current model is needed.
    expect(calls.retrieveAgent).toBe(0);
    expect(calls.retrieveConversation).toBe(0);
  });

  test("agent scope routes through updateAgent", async () => {
    const { backend, calls } = makeBackend();
    await updateModelConfig(
      backend,
      { scope: "agent", agentId: "agent-1" },
      { contextWindow: 123000 },
    );
    expect(calls.updateAgent).toHaveLength(1);
    expect(calls.updateAgent[0]?.body).toEqual({
      context_window_limit: 123000,
    });
    expect(calls.updateConversation).toHaveLength(0);
  });

  test("empty update is a no-op", async () => {
    const { backend, calls } = makeBackend();
    await updateModelConfig(backend, conversationTarget, {});
    expect(calls.updateConversation).toHaveLength(0);
    expect(calls.updateAgent).toHaveLength(0);
  });
});
