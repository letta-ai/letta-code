import { afterEach, describe, expect, test } from "bun:test";
import type { Backend } from "@/backend";
import { __testSetBackend } from "@/backend/backend";
import { updateAgentLLMConfig, updateConversationLLMConfig } from "./modify";
import { withReasoningSettings } from "./reasoning-model-settings";

// Stored settings of a conversation set to `sonnet-5-no-reasoning` (#4755).
const noReasoningSettings = {
  provider_type: "anthropic",
  max_output_tokens: 128000,
  parallel_tool_calls: true,
  temperature: 1,
  thinking: { type: "disabled", budget_tokens: 1024 },
  effort: null,
  strict: false,
};

type UpdateCall = { id: string; body: Record<string, unknown> };

function useStubBackend() {
  const calls: UpdateCall[] = [];
  const record = async (id: string, body: Record<string, unknown>) => {
    calls.push({ id, body });
    return {};
  };
  __testSetBackend({
    capabilities: { localModelCatalog: false },
    listModels: async () => [],
    updateAgent: record,
    updateConversation: record,
    retrieveAgent: async () => ({ id: "agent-1" }),
  } as unknown as Backend);
  return calls;
}

afterEach(() => {
  __testSetBackend(null);
});

describe("withReasoningSettings", () => {
  test("replaces only reasoning fields and keeps every other setting", () => {
    const settings = withReasoningSettings(noReasoningSettings, {
      provider_type: "anthropic",
      parallel_tool_calls: true,
      effort: "low",
      thinking: { type: "enabled" },
    });
    expect(settings).toEqual({
      ...noReasoningSettings,
      effort: "low",
      thinking: { type: "enabled", budget_tokens: 1024 },
    });
  });

  test("does not overwrite kept settings with rebuilt defaults", () => {
    const settings = withReasoningSettings(
      {
        provider_type: "openai",
        parallel_tool_calls: false,
        temperature: 0.7,
        max_output_tokens: 16384,
        reasoning: { reasoning_effort: "high" },
      },
      {
        provider_type: "openai",
        parallel_tool_calls: true,
        reasoning: { reasoning_effort: "low" },
      },
    );
    expect(settings).toEqual({
      provider_type: "openai",
      parallel_tool_calls: false,
      temperature: 0.7,
      max_output_tokens: 16384,
      reasoning: { reasoning_effort: "low" },
    });
  });

  test("drops an effort the new level leaves unset", () => {
    const settings = withReasoningSettings(
      {
        ...noReasoningSettings,
        effort: "max",
        thinking: { type: "enabled", budget_tokens: 1024 },
      },
      { provider_type: "anthropic", thinking: { type: "disabled" } },
    );
    expect("effort" in settings).toBe(false);
    expect(settings.thinking).toEqual({
      type: "disabled",
      budget_tokens: 1024,
    });
    expect(settings.max_output_tokens).toBe(128000);
  });
});

describe("reasoning-only updates re-send current settings (#4755)", () => {
  test("Tab from no reasoning to low keeps max_output_tokens and budget", async () => {
    const calls = useStubBackend();
    await updateConversationLLMConfig(
      "conv-1",
      "anthropic/claude-sonnet-5",
      {
        reasoning_effort: "low",
        enable_reasoner: true,
        provider_type: "anthropic",
      },
      {
        contextWindowOverride: 1000000,
        currentModelSettings: noReasoningSettings,
      },
    );
    expect(calls[0]?.body.model_settings).toEqual({
      ...noReasoningSettings,
      effort: "low",
      thinking: { type: "enabled", budget_tokens: 1024 },
    });
    expect(calls[0]?.body.context_window_limit).toBe(1000000);
  });

  test("Tab back to none turns thinking off and keeps the other settings", async () => {
    const calls = useStubBackend();
    await updateAgentLLMConfig(
      "agent-1",
      "anthropic/claude-sonnet-5",
      {
        reasoning_effort: "none",
        enable_reasoner: false,
        provider_type: "anthropic",
      },
      {
        contextWindowOverride: 1000000,
        currentModelSettings: {
          ...noReasoningSettings,
          effort: "max",
          thinking: { type: "enabled", budget_tokens: 1024 },
        },
      },
    );
    const { effort: _effort, ...withoutEffort } = noReasoningSettings;
    expect(calls[0]?.body.model_settings).toEqual(withoutEffort);
  });
});
