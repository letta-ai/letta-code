import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import {
  createAISDKModelFactory,
  DEFAULT_AI_SDK_PROVIDER,
  resolveAISDKProvider,
} from "../../backend/dev/AISDKModelFactory";

function withAISDKEnv<T>(
  env: {
    provider?: string;
    model?: string;
  },
  fn: () => T,
): T {
  const originalProvider = process.env.LETTA_CODE_DEV_AI_SDK_PROVIDER;
  const originalModel = process.env.LETTA_CODE_DEV_AI_SDK_MODEL;
  try {
    if (env.provider === undefined) {
      delete process.env.LETTA_CODE_DEV_AI_SDK_PROVIDER;
    } else {
      process.env.LETTA_CODE_DEV_AI_SDK_PROVIDER = env.provider;
    }
    if (env.model === undefined) {
      delete process.env.LETTA_CODE_DEV_AI_SDK_MODEL;
    } else {
      process.env.LETTA_CODE_DEV_AI_SDK_MODEL = env.model;
    }
    return fn();
  } finally {
    if (originalProvider === undefined) {
      delete process.env.LETTA_CODE_DEV_AI_SDK_PROVIDER;
    } else {
      process.env.LETTA_CODE_DEV_AI_SDK_PROVIDER = originalProvider;
    }
    if (originalModel === undefined) {
      delete process.env.LETTA_CODE_DEV_AI_SDK_MODEL;
    } else {
      process.env.LETTA_CODE_DEV_AI_SDK_MODEL = originalModel;
    }
  }
}

describe("AISDKModelFactory", () => {
  test("defaults to OpenAI Responses when no provider is configured", () => {
    expect(withAISDKEnv({}, () => resolveAISDKProvider())).toBe(
      DEFAULT_AI_SDK_PROVIDER,
    );
  });

  test("creates an OpenAI Responses factory from explicit provider/model", () => {
    let capturedOpenAIModel: string | undefined;
    let calledAnthropic = false;
    const model = {} as LanguageModel;
    const factory = createAISDKModelFactory({
      provider: "openai-responses",
      model: "gpt-test",
      createOpenAIResponsesModel: (modelId) => {
        capturedOpenAIModel = modelId;
        return model;
      },
      createAnthropicModel: () => {
        calledAnthropic = true;
        return {} as LanguageModel;
      },
    });

    expect(factory()).toBe(model);
    expect(capturedOpenAIModel).toBe("gpt-test");
    expect(calledAnthropic).toBe(false);
  });

  test("creates an Anthropic factory from env provider/model", () => {
    let capturedAnthropicModel: string | undefined;
    let calledOpenAI = false;
    const model = {} as LanguageModel;
    const factory = withAISDKEnv(
      { provider: "anthropic", model: "claude-env" },
      () =>
        createAISDKModelFactory({
          createOpenAIResponsesModel: () => {
            calledOpenAI = true;
            return {} as LanguageModel;
          },
          createAnthropicModel: (modelId) => {
            capturedAnthropicModel = modelId;
            return model;
          },
        }),
    );

    expect(factory()).toBe(model);
    expect(capturedAnthropicModel).toBe("claude-env");
    expect(calledOpenAI).toBe(false);
  });

  test("rejects unknown providers", () => {
    expect(() => resolveAISDKProvider("gemini")).toThrow(
      'Unknown AI SDK provider "gemini"',
    );
  });
});
