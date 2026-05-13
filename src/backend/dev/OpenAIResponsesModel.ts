import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import {
  createLocalProviderFetch,
  type LocalProviderTimeout,
} from "../local/LocalProviderTimeout";

export const DEFAULT_OPENAI_RESPONSES_MODEL = "gpt-5.5";

export interface OpenAIResponsesModelFactoryOptions {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  timeout?: LocalProviderTimeout;
  createModel?: (model: string) => LanguageModel;
}

function createDefaultOpenAIResponsesModel(options: {
  model: string;
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  timeout?: LocalProviderTimeout;
}): LanguageModel {
  const provider = createOpenAI({
    apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
    baseURL: options.baseURL,
    fetch: createLocalProviderFetch({
      fetch: options.fetch,
      timeout: options.timeout,
    }),
  });
  return provider.responses(options.model);
}

export function createOpenAIResponsesModelFactory(
  options: OpenAIResponsesModelFactoryOptions = {},
): () => LanguageModel {
  const model =
    options.model ??
    process.env.LETTA_CODE_DEV_OPENAI_MODEL ??
    DEFAULT_OPENAI_RESPONSES_MODEL;
  const createModel =
    options.createModel ??
    ((model: string) =>
      createDefaultOpenAIResponsesModel({
        model,
        apiKey: options.apiKey,
        baseURL: options.baseURL,
        fetch: options.fetch,
        timeout: options.timeout,
      }));
  return () => createModel(model);
}
