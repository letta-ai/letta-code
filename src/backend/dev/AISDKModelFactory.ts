import type { LanguageModel } from "ai";
import { createAnthropicModelFactory } from "./AnthropicModel";
import { createOpenAIResponsesModelFactory } from "./OpenAIResponsesModel";

export const DEFAULT_AI_SDK_PROVIDER = "openai-responses";

export type AISDKProvider = "openai-responses" | "anthropic";

export interface AISDKModelFactoryOptions {
  provider?: string;
  model?: string;
  createOpenAIResponsesModel?: (model: string) => LanguageModel;
  createAnthropicModel?: (model: string) => LanguageModel;
}

export interface AISDKModelSettings {
  provider_type?: unknown;
}

function hasEnvValue(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0;
}

function inferDefaultProviderFromStandardKeys(): AISDKProvider {
  const hasOpenAIKey = hasEnvValue(process.env.OPENAI_API_KEY);
  const hasAnthropicKey = hasEnvValue(process.env.ANTHROPIC_API_KEY);

  if (!hasOpenAIKey && hasAnthropicKey) return "anthropic";
  return DEFAULT_AI_SDK_PROVIDER;
}

export function resolveAISDKProvider(
  provider = process.env.LETTA_CODE_DEV_AI_SDK_PROVIDER ??
    inferDefaultProviderFromStandardKeys(),
): AISDKProvider {
  if (provider === "openai") return "openai-responses";
  if (provider === "openai-responses" || provider === "anthropic") {
    return provider;
  }
  throw new Error(
    `Unknown AI SDK provider "${provider}". Expected "openai-responses" or "anthropic".`,
  );
}

export function resolveAISDKProviderFromAgent(
  model: string | undefined,
  modelSettings: AISDKModelSettings = {},
): AISDKProvider {
  const providerType = modelSettings.provider_type;
  if (providerType === "anthropic") return "anthropic";
  if (providerType === "openai" || providerType === "openai-responses") {
    return "openai-responses";
  }
  if (model?.startsWith("anthropic/")) return "anthropic";
  if (model?.startsWith("openai/") || model?.startsWith("openai-responses/")) {
    return "openai-responses";
  }
  return resolveAISDKProvider();
}

export function resolveAISDKModelFromAgent(
  model: string | undefined,
  provider: AISDKProvider,
): string | undefined {
  if (!model) return process.env.LETTA_CODE_DEV_AI_SDK_MODEL;
  if (provider === "anthropic" && model.startsWith("anthropic/")) {
    return model.slice("anthropic/".length);
  }
  if (
    provider === "openai-responses" &&
    model.startsWith("openai-responses/")
  ) {
    return model.slice("openai-responses/".length);
  }
  if (provider === "openai-responses" && model.startsWith("openai/")) {
    return model.slice("openai/".length);
  }
  return model;
}

export function createAISDKModelFactoryFromAgent(
  model: string | undefined,
  modelSettings: AISDKModelSettings = {},
  options: Omit<AISDKModelFactoryOptions, "provider" | "model"> = {},
): () => LanguageModel {
  const provider = resolveAISDKProviderFromAgent(model, modelSettings);
  return createAISDKModelFactory({
    ...options,
    provider,
    model: resolveAISDKModelFromAgent(model, provider),
  });
}

export function createAISDKModelFactory(
  options: AISDKModelFactoryOptions = {},
): () => LanguageModel {
  const provider = resolveAISDKProvider(options.provider);
  const model = options.model ?? process.env.LETTA_CODE_DEV_AI_SDK_MODEL;

  switch (provider) {
    case "openai-responses":
      return createOpenAIResponsesModelFactory({
        model,
        createModel: options.createOpenAIResponsesModel,
      });
    case "anthropic":
      return createAnthropicModelFactory({
        model,
        createModel: options.createAnthropicModel,
      });
  }
}
