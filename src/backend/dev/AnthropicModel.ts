import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

export interface AnthropicModelFactoryOptions {
  model?: string;
  apiKey?: string;
  fetch?: typeof fetch;
  createModel?: (model: string) => LanguageModel;
}

function createDefaultAnthropicModel(options: {
  model: string;
  apiKey?: string;
  fetch?: typeof fetch;
}): LanguageModel {
  const provider = createAnthropic({
    apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY,
    fetch: options.fetch,
  });
  return provider(options.model);
}

export function createAnthropicModelFactory(
  options: AnthropicModelFactoryOptions = {},
): () => LanguageModel {
  const model =
    options.model ??
    process.env.LETTA_CODE_DEV_ANTHROPIC_MODEL ??
    DEFAULT_ANTHROPIC_MODEL;
  const createModel =
    options.createModel ??
    ((model: string) =>
      createDefaultAnthropicModel({
        model,
        apiKey: options.apiKey,
        fetch: options.fetch,
      }));
  return () => createModel(model);
}
