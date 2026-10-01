import { describe, expect, test } from "bun:test";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";
import { resolveForkModelOverride } from "./subagent-model";

setupRuntimeModelCatalogFixture();

function availableModels() {
  return {
    handles: new Set([
      "openai/gpt-5.6-sol",
      "feather-openai/gpt-5.6-terra",
      "feather-openai/gpt-5.6-sol",
    ]),
    providerTypes: new Map([
      ["openai/gpt-5.6-sol", "openai"],
      ["feather-openai/gpt-5.6-terra", "openai"],
      ["feather-openai/gpt-5.6-sol", "openai"],
    ]),
    openAICompatibleProxyHandles: new Set<string>(),
    models: [],
    source: "network" as const,
    fetchedAt: Date.now(),
  };
}

describe("resolveForkModelOverride", () => {
  test("keeps the parent's BYOK provider and catalog reasoning preset", async () => {
    const result = await resolveForkModelOverride({
      userModel: "gpt-5.6-sol",
      parentModelHandle: "feather-openai/gpt-5.6-terra",
      availableModels: availableModels(),
    });

    expect(result).toMatchObject({
      modelHandle: "feather-openai/gpt-5.6-sol",
      updateArgs: {
        reasoning_effort: "high",
        context_window: 350000,
        max_output_tokens: 128000,
        provider_type: "openai",
      },
    });
  });

  test("honors a user-configured fork model when the tool omits one", async () => {
    const result = await resolveForkModelOverride({
      recommendedModel: "gpt-5.6-sol",
      recommendedModelSource: "user",
      parentModelHandle: "feather-openai/gpt-5.6-terra",
      availableModels: availableModels(),
    });

    expect(result?.modelHandle).toBe("feather-openai/gpt-5.6-sol");
    expect(result?.updateArgs?.reasoning_effort).toBe("high");
  });

  test("explicit inherit wins over a configured fork model", async () => {
    const result = await resolveForkModelOverride({
      userModel: "inherit",
      recommendedModel: "gpt-5.6-sol",
      recommendedModelSource: "user",
      parentModelHandle: "feather-openai/gpt-5.6-terra",
      availableModels: availableModels(),
    });

    expect(result).toBeNull();
  });

  test("built-in inheritance leaves the fork model untouched", async () => {
    const result = await resolveForkModelOverride({
      recommendedModel: "inherit",
      recommendedModelSource: "builtin",
      parentModelHandle: "feather-openai/gpt-5.6-terra",
      availableModels: availableModels(),
    });

    expect(result).toBeNull();
  });

  test("rejects an unknown model before a fork is created", async () => {
    await expect(
      resolveForkModelOverride({
        userModel: "missing-model",
        parentModelHandle: "feather-openai/gpt-5.6-terra",
        availableModels: availableModels(),
      }),
    ).rejects.toThrow("Unknown fork model: missing-model");
  });

  test("rejects a catalog model that the active backend cannot use", async () => {
    const available = availableModels();
    available.handles.delete("openai/gpt-5.6-sol");
    available.handles.delete("feather-openai/gpt-5.6-sol");

    await expect(
      resolveForkModelOverride({
        userModel: "gpt-5.6-sol",
        parentModelHandle: "feather-openai/gpt-5.6-terra",
        availableModels: available,
      }),
    ).rejects.toThrow("Fork model is not available: gpt-5.6-sol");
  });
});
