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

export function resolveAISDKProvider(
  provider = process.env.LETTA_CODE_DEV_AI_SDK_PROVIDER ??
    DEFAULT_AI_SDK_PROVIDER,
): AISDKProvider {
  if (provider === "openai-responses" || provider === "anthropic") {
    return provider;
  }
  throw new Error(
    `Unknown AI SDK provider "${provider}". Expected "openai-responses" or "anthropic".`,
  );
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
