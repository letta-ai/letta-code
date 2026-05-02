import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import {
  createAISDKModelFactory,
  createAISDKModelFactoryFromAgent,
  DEFAULT_AI_SDK_PROVIDER,
  resolveAISDKModelFromAgent,
  resolveAISDKProvider,
  resolveAISDKProviderFromAgent,
} from "../../backend/dev/AISDKModelFactory";

function withAISDKEnv<T>(
  env: {
    provider?: string;
    model?: string;
    openAIKey?: string;
    anthropicKey?: string;
  },
  fn: () => T,
): T {
  const originalProvider = process.env.LETTA_CODE_DEV_AI_SDK_PROVIDER;
  const originalModel = process.env.LETTA_CODE_DEV_AI_SDK_MODEL;
  const originalOpenAIKey = process.env.OPENAI_API_KEY;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
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
    if (env.openAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = env.openAIKey;
    }
    if (env.anthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = env.anthropicKey;
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
    if (originalOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
    if (originalAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    }
  }
}

describe("AISDKModelFactory", () => {
  test("defaults to OpenAI Responses when no provider is configured", () => {
    expect(withAISDKEnv({}, () => resolveAISDKProvider())).toBe(
      DEFAULT_AI_SDK_PROVIDER,
    );
  });

  test("defaults to Anthropic when it is the only standard provider key", () => {
    expect(
      withAISDKEnv({ anthropicKey: "test-anthropic-key" }, () =>
        resolveAISDKProvider(),
      ),
    ).toBe("anthropic");
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

  test("uses explicit dev provider and model env when no agent model is available", () => {
    let capturedAnthropicModel: string | undefined;
    const model = {} as LanguageModel;
    const factory = withAISDKEnv(
      {
        provider: "anthropic",
        model: "claude-dev",
      },
      () =>
        createAISDKModelFactory({
          createAnthropicModel: (modelId) => {
            capturedAnthropicModel = modelId;
            return model;
          },
        }),
    );

    expect(factory()).toBe(model);
    expect(capturedAnthropicModel).toBe("claude-dev");
  });

  test("rejects unknown providers", () => {
    expect(() => resolveAISDKProvider("gemini")).toThrow(
      'Unknown AI SDK provider "gemini"',
    );
  });

  test("resolves provider and model from agent state", () => {
    expect(resolveAISDKProviderFromAgent("anthropic/claude-agent", {})).toBe(
      "anthropic",
    );
    expect(
      resolveAISDKProviderFromAgent("gpt-agent", { provider_type: "openai" }),
    ).toBe("openai-responses");
    expect(
      resolveAISDKModelFromAgent("anthropic/claude-agent", "anthropic"),
    ).toBe("claude-agent");
    expect(
      resolveAISDKModelFromAgent("openai/gpt-agent", "openai-responses"),
    ).toBe("gpt-agent");
  });

  test("creates a model factory from agent state", () => {
    let capturedAnthropicModel: string | undefined;
    const model = {} as LanguageModel;
    const factory = createAISDKModelFactoryFromAgent(
      "anthropic/claude-agent",
      { provider_type: "anthropic" },
      {
        createAnthropicModel: (modelId) => {
          capturedAnthropicModel = modelId;
          return model;
        },
      },
    );

    expect(factory()).toBe(model);
    expect(capturedAnthropicModel).toBe("claude-agent");
  });
});
