import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { models } from "@/agent/model-catalog";
import {
  mapModelHandleToLlmConfigPatch,
  normalizeModelHandleForRegistry,
  resolveModelHandleFromLlmConfig,
} from "@/agent/model-handles";
import {
  clearRuntimeModelCatalogFixture,
  installRuntimeModelCatalogFixture,
} from "@/test-utils/runtime-model-catalog";

beforeEach(installRuntimeModelCatalogFixture);
afterEach(clearRuntimeModelCatalogFixture);

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

  test("keeps a catalog moonshotai handle distinct from the moonshot alias", () => {
    models.push({
      id: "kimi-k3-openrouter",
      handle: "moonshotai/kimi-k3",
      label: "Kimi K3",
      description: "Moonshot AI's Kimi K3 model (high reasoning)",
      updateArgs: {
        context_window: 1048576,
        reasoning_effort: "high",
      },
    });

    expect(normalizeModelHandleForRegistry("moonshotai/kimi-k3")).toBe(
      "moonshotai/kimi-k3",
    );
    expect(normalizeModelHandleForRegistry("moonshot/kimi-k3")).toBe(
      "moonshot/kimi-k3",
    );
    expect(normalizeModelHandleForRegistry("moonshotai/kimi-k3-unlisted")).toBe(
      "moonshot/kimi-k3-unlisted",
    );
    expect(mapModelHandleToLlmConfigPatch("moonshotai/kimi-k3")).toEqual({
      model: "moonshotai/kimi-k3",
      model_endpoint_type: "openrouter",
    });
    expect(mapModelHandleToLlmConfigPatch("moonshot/kimi-k3")).toEqual({
      model: "kimi-k3",
      model_endpoint_type: "moonshot",
    });
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
