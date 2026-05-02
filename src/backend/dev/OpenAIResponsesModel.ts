import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export const DEFAULT_OPENAI_RESPONSES_MODEL = "gpt-5.5";

export interface OpenAIResponsesModelFactoryOptions {
  model?: string;
  apiKey?: string;
  fetch?: typeof fetch;
  createModel?: (model: string) => LanguageModel;
}

function createDefaultOpenAIResponsesModel(options: {
  model: string;
  apiKey?: string;
  fetch?: typeof fetch;
}): LanguageModel {
  const provider = createOpenAI({
    apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
    fetch: options.fetch,
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
        fetch: options.fetch,
      }));
  return () => createModel(model);
}
