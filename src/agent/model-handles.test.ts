import { describe, expect, test } from "bun:test";
import {
  mapModelHandleToLlmConfigPatch,
  resolveModelHandleFromLlmConfig,
} from "@/agent/model-handles";

describe("model handles", () => {
  test("prefers canonical provider handles over stale endpoint types", () => {
    expect(
      resolveModelHandleFromLlmConfig({
        model: "anthropic/claude-sonnet-4-6",
        model_endpoint_type: "openai",
      }),
    ).toBe("anthropic/claude-sonnet-4-6");
    expect(
      resolveModelHandleFromLlmConfig({
        model: "claude-sonnet-4-6",
        model_endpoint_type: "openai",
      }),
    ).toBe("anthropic/claude-sonnet-4-6");
  });

  test("preserves provider-namespaced OpenRouter model names", () => {
    expect(
      resolveModelHandleFromLlmConfig({
        model: "z-ai/glm-4.6:exacto",
        model_endpoint_type: "openrouter",
      }),
    ).toBe("openrouter/z-ai/glm-4.6:exacto");
    expect(
      resolveModelHandleFromLlmConfig({
        model: "anthropic/claude-sonnet-4-6",
        model_endpoint_type: "openrouter",
      }),
    ).toBe("openrouter/anthropic/claude-sonnet-4-6");
  });

  test("round-trips modern local provider aliases through legacy config", () => {
    expect(
      resolveModelHandleFromLlmConfig({
        model: "gemma-4-26B-A4B-it-oQ6",
        model_endpoint_type: "lmstudio_openai",
      }),
    ).toBe("lmstudio/gemma-4-26B-A4B-it-oQ6");
    expect(
      resolveModelHandleFromLlmConfig({
        model: "llama3.2",
        model_endpoint_type: "ollama_cloud",
      }),
    ).toBe("ollama-cloud/llama3.2");
    expect(mapModelHandleToLlmConfigPatch("llama.cpp/local-model")).toEqual({
      model: "local-model",
      model_endpoint_type: "llamacpp",
    });
    expect(mapModelHandleToLlmConfigPatch("lmstudio/local-model")).toEqual({
      model: "local-model",
      model_endpoint_type: "lmstudio",
    });
    expect(mapModelHandleToLlmConfigPatch("ollama-cloud/local-model")).toEqual({
      model: "ollama-cloud/local-model",
      model_endpoint_type: "openai",
    });
    expect(
      resolveModelHandleFromLlmConfig({
        model: "local-model",
        model_endpoint_type: "llamacpp",
      }),
    ).toBe("llama.cpp/local-model");
    expect(
      resolveModelHandleFromLlmConfig({
        model: "local-model",
        model_endpoint_type: "lmstudio",
      }),
    ).toBe("lmstudio/local-model");
    expect(
      resolveModelHandleFromLlmConfig({
        model: "ollama-cloud/local-model",
        model_endpoint_type: "openai",
      }),
    ).toBe("ollama-cloud/local-model");
  });

  test("does not reapply stale provider metadata to canonical handles", () => {
    expect(
      mapModelHandleToLlmConfigPatch("anthropic/claude-sonnet-4-6", "openai"),
    ).toEqual({
      model: "claude-sonnet-4-6",
      model_endpoint_type: "anthropic",
    });
  });
});
