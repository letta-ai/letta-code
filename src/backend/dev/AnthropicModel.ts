import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import {
  createLocalProviderFetch,
  type LocalProviderTimeout,
} from "../local/LocalProviderTimeout";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

export interface AnthropicModelFactoryOptions {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  providerName?: string;
  fetch?: typeof fetch;
  timeout?: LocalProviderTimeout;
  createModel?: (model: string) => LanguageModel;
}

function createDefaultAnthropicModel(options: {
  model: string;
  apiKey?: string;
  baseURL?: string;
  providerName?: string;
  fetch?: typeof fetch;
  timeout?: LocalProviderTimeout;
}): LanguageModel {
  const provider = createAnthropic({
    apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY,
    baseURL: options.baseURL,
    name: options.providerName,
    fetch: createLocalProviderFetch({
      fetch: options.fetch,
      timeout: options.timeout,
    }),
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
        baseURL: options.baseURL,
        providerName: options.providerName,
        fetch: options.fetch,
        timeout: options.timeout,
      }));
  return () => createModel(model);
}
