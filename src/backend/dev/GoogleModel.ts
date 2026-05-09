import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

export interface GoogleModelFactoryOptions {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  createModel?: (model: string) => LanguageModel;
}

function createDefaultGoogleModel(options: {
  model: string;
  apiKey?: string;
  baseURL?: string;
}): LanguageModel {
  const provider = createGoogleGenerativeAI({
    apiKey:
      options.apiKey ??
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
      process.env.GEMINI_API_KEY,
    baseURL: options.baseURL,
    name: "google-ai",
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
      }));
  return () => createModel(model);
}
