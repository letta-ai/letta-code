import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import {
  createOpenAIResponsesModelFactory,
  DEFAULT_OPENAI_RESPONSES_MODEL,
} from "../../backend/dev/OpenAIResponsesModel";

describe("OpenAIResponsesModel", () => {
  test("creates a model factory from an explicit model id", () => {
    let capturedModel: string | undefined;
    const model = {} as LanguageModel;
    const factory = createOpenAIResponsesModelFactory({
      model: "gpt-test",
      createModel: (modelId) => {
        capturedModel = modelId;
        return model;
      },
    });

    expect(factory()).toBe(model);
    expect(capturedModel).toBe("gpt-test");
  });

  test("defaults to the configured OpenAI Responses model", () => {
    const originalModel = process.env.LETTA_CODE_DEV_OPENAI_MODEL;
    delete process.env.LETTA_CODE_DEV_OPENAI_MODEL;
    let capturedModel: string | undefined;
    try {
      const factory = createOpenAIResponsesModelFactory({
        createModel: (modelId) => {
          capturedModel = modelId;
          return {} as LanguageModel;
        },
      });

      factory();
      expect(capturedModel).toBe(DEFAULT_OPENAI_RESPONSES_MODEL);
    } finally {
      if (originalModel === undefined) {
        delete process.env.LETTA_CODE_DEV_OPENAI_MODEL;
      } else {
        process.env.LETTA_CODE_DEV_OPENAI_MODEL = originalModel;
      }
    }
  });
});
