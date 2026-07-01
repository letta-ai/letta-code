import { describe, expect, test } from "bun:test";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import {
  buildModelHandleFromLlmConfig,
  mapHandleToLlmConfigPatch,
  providerTypeFromModelSettings,
  providerTypeFromUpdateArgs,
} from "./model-config";

describe("model config helpers", () => {
  test("prefers canonical provider handles over stale llm_config endpoint types", () => {
    expect(
      buildModelHandleFromLlmConfig({
        model: "anthropic/claude-sonnet-4-6",
        model_endpoint_type: "openai",
      } as LlmConfig),
    ).toBe("anthropic/claude-sonnet-4-6");
  });

  test("canonicalizes unique bare model names from stale llm_config endpoint types", () => {
    expect(
      buildModelHandleFromLlmConfig({
        model: "claude-sonnet-4-6",
        model_endpoint_type: "openai",
      } as LlmConfig),
    ).toBe("anthropic/claude-sonnet-4-6");
  });

  test("preserves OpenRouter model names that contain slashes", () => {
    expect(
      buildModelHandleFromLlmConfig({
        model: "z-ai/glm-4.6:exacto",
        model_endpoint_type: "openrouter",
      } as LlmConfig),
    ).toBe("openrouter/z-ai/glm-4.6:exacto");
  });

  test("does not collapse OpenRouter namespaced models to direct providers", () => {
    expect(
      buildModelHandleFromLlmConfig({
        model: "anthropic/claude-sonnet-4-6",
        model_endpoint_type: "openrouter",
      } as LlmConfig),
    ).toBe("openrouter/anthropic/claude-sonnet-4-6");
  });

  test("maps local endpoint aliases back to canonical handle prefixes", () => {
    expect(
      buildModelHandleFromLlmConfig({
        model: "gemma-4-26B-A4B-it-oQ6",
        model_endpoint_type: "lmstudio_openai",
      } as unknown as LlmConfig),
    ).toBe("lmstudio/gemma-4-26B-A4B-it-oQ6");
    expect(
      buildModelHandleFromLlmConfig({
        model: "llama3.2",
        model_endpoint_type: "ollama_cloud",
      } as unknown as LlmConfig),
    ).toBe("ollama-cloud/llama3.2");
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

  test("extracts provider type from model settings and update args", () => {
    expect(
      providerTypeFromModelSettings({ provider_type: "chatgpt_oauth" }),
    ).toBe("chatgpt_oauth");
    expect(providerTypeFromUpdateArgs({ provider_type: "chatgpt_oauth" })).toBe(
      "chatgpt_oauth",
    );
  });
});
