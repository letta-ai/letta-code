import { describe, expect, test } from "bun:test";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import { models } from "@/agent/model";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";
import {
  deriveReasoningEffort,
  mapHandleToLlmConfigPatch,
  providerTypeFromModelSettings,
  providerTypeFromUpdateArgs,
  reasoningEffortLlmConfigPatch,
  resolveModelSelectionReasoningHandle,
} from "./model-config";

setupRuntimeModelCatalogFixture();

describe("model config helpers", () => {
  test("uses a local runtime handle for reasoning tiers when it is present", () => {
    models.push({
      id: "gpt-5.6-sol-local-medium",
      handle: "openai-codex/gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      description: "",
      updateArgs: { reasoning_effort: "medium" },
    });

    expect(
      resolveModelSelectionReasoningHandle(
        "openai-codex/gpt-5.6-sol",
        "chatgpt-plus-pro/gpt-5.6-sol",
      ),
    ).toBe("openai-codex/gpt-5.6-sol");
  });

  test("uses the registry handle when the selected alias is not in the catalog", () => {
    expect(
      resolveModelSelectionReasoningHandle(
        "lc-minimax/MiniMax-M3",
        "minimax/MiniMax-M3",
      ),
    ).toBe("minimax/MiniMax-M3");
    expect(
      resolveModelSelectionReasoningHandle(
        "chatgpt-personal/gpt-5.6-sol",
        "chatgpt-plus-pro/gpt-5.6-sol",
      ),
    ).toBe("chatgpt-plus-pro/gpt-5.6-sol");
  });

  test("maps custom ChatGPT OAuth alias handles using provider type metadata", () => {
    expect(
      mapHandleToLlmConfigPatch("chatgpt-personal/gpt-5.5", "chatgpt_oauth"),
    ).toEqual({
      model: "gpt-5.5",
      model_endpoint_type: "chatgpt_oauth",
    });
  });

  test("does not invent endpoint type from unknown aliases without metadata", () => {
    expect(mapHandleToLlmConfigPatch("chatgpt-personal/gpt-5.5")).toEqual({
      model: "chatgpt-personal/gpt-5.5",
    });
  });

  test("maps Kimi K3 direct and OpenRouter handles to backend llm_config fields", () => {
    expect(
      mapHandleToLlmConfigPatch("moonshot/kimi-k3") as Record<string, unknown>,
    ).toEqual({
      model: "kimi-k3",
      model_endpoint_type: "moonshot",
    });
    expect(
      mapHandleToLlmConfigPatch("openrouter/moonshotai/kimi-k3") as Record<
        string,
        unknown
      >,
    ).toEqual({
      model: "moonshotai/kimi-k3",
      model_endpoint_type: "openrouter",
    });
  });

  test("extracts provider type from model settings and update args", () => {
    expect(
      providerTypeFromModelSettings({ provider_type: "chatgpt_oauth" }),
    ).toBe("chatgpt_oauth");
    expect(providerTypeFromUpdateArgs({ provider_type: "chatgpt_oauth" })).toBe(
      "chatgpt_oauth",
    );
  });

  test("derives GPT-5.6 max from OpenAI-family model settings", () => {
    expect(
      deriveReasoningEffort(
        {
          provider_type: "chatgpt_oauth",
          reasoning: { reasoning_effort: "max" },
        } as never,
        null,
      ),
    ).toBe("max");
  });

  test("lets an explicit provider default clear stale legacy effort", () => {
    const modelSettings = {
      provider_type: "openai",
      reasoning: null,
    } as unknown as AgentState["model_settings"];
    const llmConfig = {
      reasoning_effort: "high",
    } as LlmConfig;

    expect(deriveReasoningEffort(modelSettings, llmConfig)).toBeNull();
    expect(reasoningEffortLlmConfigPatch(modelSettings, llmConfig)).toEqual({
      reasoning_effort: null,
    });
  });

  test("does not interpret an absent reasoning field as provider Default", () => {
    const modelSettings = {
      provider_type: "openai",
    } as unknown as AgentState["model_settings"];
    const llmConfig = {
      reasoning_effort: "high",
    } as LlmConfig;

    expect(reasoningEffortLlmConfigPatch(modelSettings, llmConfig)).toEqual({
      reasoning_effort: "high",
    });
  });

  test("does not expose Moonshot reasoning controls", () => {
    expect(
      deriveReasoningEffort(
        {
          provider_type: "moonshot",
          reasoning_effort: "max",
        } as never,
        null,
      ),
    ).toBeNull();
  });
});
