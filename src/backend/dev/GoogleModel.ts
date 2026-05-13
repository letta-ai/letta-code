import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import {
  createLocalProviderFetch,
  type LocalProviderTimeout,
} from "../local/LocalProviderTimeout";

export interface GoogleModelFactoryOptions {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  timeout?: LocalProviderTimeout;
  createModel?: (model: string) => LanguageModel;
}

function createDefaultGoogleModel(options: {
  model: string;
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  timeout?: LocalProviderTimeout;
}): LanguageModel {
  const provider = createGoogleGenerativeAI({
    apiKey:
      options.apiKey ??
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
      process.env.GEMINI_API_KEY,
    baseURL: options.baseURL,
    name: "google-ai",
    fetch: createLocalProviderFetch({
      fetch: options.fetch,
      timeout: options.timeout,
    }),
  });
  return provider(options.model);
}

export function createGoogleModelFactory(
  options: GoogleModelFactoryOptions = {},
): () => LanguageModel {
  const model = options.model;
  if (!model) {
    throw new Error("No model configured for Google Gemini.");
  }
  const createModel =
    options.createModel ??
    ((model: string) =>
      createDefaultGoogleModel({
        model,
        apiKey: options.apiKey,
        baseURL: options.baseURL,
        fetch: options.fetch,
        timeout: options.timeout,
      }));
  return () => createModel(model);
}
