import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import {
  createAnthropicModelFactory,
  DEFAULT_ANTHROPIC_MODEL,
} from "../../backend/dev/AnthropicModel";

describe("AnthropicModel", () => {
  test("creates a model factory from an explicit model id", () => {
    let capturedModel: string | undefined;
    const model = {} as LanguageModel;
    const factory = createAnthropicModelFactory({
      model: "claude-test",
      createModel: (modelId) => {
        capturedModel = modelId;
        return model;
      },
    });

    expect(factory()).toBe(model);
    expect(capturedModel).toBe("claude-test");
  });

  test("defaults to the configured Anthropic model", () => {
    const originalModel = process.env.LETTA_CODE_DEV_ANTHROPIC_MODEL;
    delete process.env.LETTA_CODE_DEV_ANTHROPIC_MODEL;
    let capturedModel: string | undefined;
    try {
      const factory = createAnthropicModelFactory({
        createModel: (modelId) => {
          capturedModel = modelId;
          return {} as LanguageModel;
        },
      });

      factory();
      expect(capturedModel).toBe(DEFAULT_ANTHROPIC_MODEL);
    } finally {
      if (originalModel === undefined) {
        delete process.env.LETTA_CODE_DEV_ANTHROPIC_MODEL;
      } else {
        process.env.LETTA_CODE_DEV_ANTHROPIC_MODEL = originalModel;
      }
    }
  });
});
