import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import {
  createLocalProviderFetch,
  type LocalProviderTimeout,
} from "../local/LocalProviderTimeout";

export interface OpenAICompatibleModelFactoryOptions {
  model?: string;
  apiKey?: string;
  baseURL: string;
  providerName: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeout?: LocalProviderTimeout;
  createModel?: (model: string) => LanguageModel;
}

function createDefaultOpenAICompatibleModel(options: {
  model: string;
  apiKey?: string;
  baseURL: string;
  providerName: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeout?: LocalProviderTimeout;
}): LanguageModel {
  const provider = createOpenAI({
    name: options.providerName,
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    headers: options.headers,
    fetch: createLocalProviderFetch({
      fetch: options.fetch,
      timeout: options.timeout,
    }),
  });
  return provider.chat(options.model);
}

export function createOpenAICompatibleModelFactory(
  options: OpenAICompatibleModelFactoryOptions,
): () => LanguageModel {
  const model = options.model;
  if (!model) {
    throw new Error(`No model configured for ${options.providerName}.`);
  }
  if (!options.apiKey) {
    throw new Error(
      `${options.providerName} API key is not configured. Run /connect ${options.providerName}.`,
    );
  }
  const createModel =
    options.createModel ??
    ((model: string) =>
      createDefaultOpenAICompatibleModel({
        model,
        apiKey: options.apiKey,
        baseURL: options.baseURL,
        providerName: options.providerName,
        headers: options.headers,
        fetch: options.fetch,
        timeout: options.timeout,
      }));
  return () => createModel(model);
}
