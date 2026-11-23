import { describe, expect, test } from "bun:test";
import { resolveSubagentModel } from "@/agent/subagents/subagent-model";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";

describe("resolveSubagentModel with runtime catalog", () => {
  setupRuntimeModelCatalogFixture();

  test("preserves an effort-suffixed catalog ID pin instead of the bare handle", async () => {
    const result = await resolveSubagentModel({
      recommendedModel: "gpt-5.6-sol-plus-pro-high",
      recommendedModelSource: "user",
      parentModelHandle: "chatgpt-plus-pro/gpt-5.6-sol",
      availableHandles: new Set(["chatgpt-plus-pro/gpt-5.6-sol"]),
    });

    expect(result).toBe("gpt-5.6-sol-plus-pro-high");
  });

  test("preserves a suffixed pin without a parent model", async () => {
    const result = await resolveSubagentModel({
      recommendedModel: "gpt-5.6-sol-plus-pro-high",
      availableHandles: new Set(["chatgpt-plus-pro/gpt-5.6-sol"]),
    });

    expect(result).toBe("gpt-5.6-sol-plus-pro-high");
  });

  test("handle-form pins still return the handle unchanged", async () => {
    const result = await resolveSubagentModel({
      recommendedModel: "anthropic/claude-fable-5",
      availableHandles: new Set(["anthropic/claude-fable-5"]),
    });

    expect(result).toBe("anthropic/claude-fable-5");
  });

  test("BYOK provider swap still returns the swapped handle, not the catalog ID", async () => {
    const result = await resolveSubagentModel({
      recommendedModel: "gpt-5.6-sol-low",
      parentModelHandle: "lc-openai/parent-model",
      availableHandles: new Set(["lc-openai/gpt-5.6-sol"]),
    });

    expect(result).toBe("lc-openai/gpt-5.6-sol");
  });
});
