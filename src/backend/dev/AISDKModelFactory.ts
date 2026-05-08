import type { LanguageModel } from "ai";
import {
  getLocalProviderApiKeyByName,
  LOCAL_ANTHROPIC_PROVIDER_NAME,
  LOCAL_BEDROCK_PROVIDER_NAME,
  LOCAL_GOOGLE_AI_PROVIDER_NAME,
  LOCAL_KIMI_CODE_PROVIDER_NAME,
  LOCAL_LMSTUDIO_PROVIDER_NAME,
  LOCAL_MINIMAX_PROVIDER_NAME,
  LOCAL_MOONSHOT_PROVIDER_NAME,
  LOCAL_OLLAMA_CLOUD_PROVIDER_NAME,
  LOCAL_OLLAMA_PROVIDER_NAME,
  LOCAL_OPENAI_PROVIDER_NAME,
  LOCAL_OPENROUTER_PROVIDER_NAME,
  LOCAL_ZAI_CODING_PROVIDER_NAME,
  LOCAL_ZAI_PROVIDER_NAME,
} from "../local/LocalProviderAuthStore";
import { createAnthropicModelFactory } from "./AnthropicModel";
import { createBedrockModelFactory } from "./BedrockModel";
import { createChatGPTOAuthModelFactory } from "./ChatGPTOAuthModel";
import { createGoogleModelFactory } from "./GoogleModel";
import { createOpenAICompatibleModelFactory } from "./OpenAICompatibleModel";
import { createOpenAIResponsesModelFactory } from "./OpenAIResponsesModel";

export const DEFAULT_AI_SDK_PROVIDER = "openai-responses";

export type AISDKProvider =
  | "openai-responses"
  | "anthropic"
  | "openrouter"
  | "zai"
  | "minimax"
  | "moonshot"
  | "google-ai"
  | "ollama"
  | "ollama-cloud"
  | "lmstudio"
  | "bedrock"
  | "chatgpt-oauth";

export interface AISDKModelFactoryOptions {
  provider?: string;
  model?: string;
  createOpenAIResponsesModel?: (model: string) => LanguageModel;
  createAnthropicModel?: (model: string) => LanguageModel;
  createOpenAICompatibleModel?: (model: string) => LanguageModel;
  createChatGPTOAuthModel?: (model: string) => LanguageModel;
  createGoogleModel?: (model: string) => LanguageModel;
  createBedrockModel?: (model: string) => LanguageModel;
  localProviderAuthStorageDir?: string;
  zaiProviderType?: "zai" | "zai_coding";
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
  if (
    provider === "openai-responses" ||
    provider === "anthropic" ||
    provider === "openrouter" ||
    provider === "zai" ||
    provider === "minimax" ||
    provider === "moonshot" ||
    provider === "google-ai" ||
    provider === "ollama" ||
    provider === "ollama-cloud" ||
    provider === "lmstudio" ||
    provider === "bedrock" ||
    provider === "chatgpt-oauth"
  ) {
    return provider;
  }
  throw new Error(
    `Unknown AI SDK provider "${provider}". Expected "openai-responses", "anthropic", "openrouter", "zai", "minimax", "moonshot", "google-ai", "ollama", "ollama-cloud", "lmstudio", "bedrock", or "chatgpt-oauth".`,
  );
}

export function resolveAISDKProviderFromAgent(
  model: string | undefined,
  modelSettings: AISDKModelSettings = {},
): AISDKProvider {
  if (model?.startsWith("chatgpt-plus-pro/")) return "chatgpt-oauth";
  if (model?.startsWith("openrouter/")) return "openrouter";
  if (model?.startsWith("zai/")) return "zai";
  if (model?.startsWith("minimax/")) return "minimax";
  if (model?.startsWith("moonshot/") || model?.startsWith("moonshot_coding/")) {
    return "moonshot";
  }
  if (model?.startsWith("google_ai/")) return "google-ai";
  if (model?.startsWith("ollama/")) return "ollama";
  if (model?.startsWith("ollama-cloud/")) return "ollama-cloud";
  if (model?.startsWith("lmstudio/")) return "lmstudio";
  if (model?.startsWith("bedrock/")) return "bedrock";
  if (model?.startsWith("anthropic/")) return "anthropic";
  if (model?.startsWith("openai/") || model?.startsWith("openai-responses/")) {
    return "openai-responses";
  }

  const providerType = modelSettings.provider_type;
  if (providerType === "anthropic") return "anthropic";
  if (providerType === "openrouter") return "openrouter";
  if (providerType === "zai" || providerType === "zai_coding") return "zai";
  if (providerType === "minimax") return "minimax";
  if (providerType === "moonshot" || providerType === "moonshot_coding") {
    return "moonshot";
  }
  if (providerType === "google_ai") return "google-ai";
  if (providerType === "ollama") return "ollama";
  if (providerType === "ollama_cloud") return "ollama-cloud";
  if (providerType === "lmstudio") return "lmstudio";
  if (providerType === "bedrock") return "bedrock";
  if (providerType === "chatgpt_oauth") return "chatgpt-oauth";
  if (providerType === "openai" || providerType === "openai-responses") {
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
  if (provider === "openrouter" && model.startsWith("openrouter/")) {
    return model.slice("openrouter/".length);
  }
  if (provider === "zai" && model.startsWith("zai/")) {
    return model.slice("zai/".length);
  }
  if (provider === "minimax" && model.startsWith("minimax/")) {
    return model.slice("minimax/".length);
  }
  if (provider === "moonshot" && model.startsWith("moonshot/")) {
    return model.slice("moonshot/".length);
  }
  if (provider === "moonshot" && model.startsWith("moonshot_coding/")) {
    return model.slice("moonshot_coding/".length);
  }
  if (provider === "google-ai" && model.startsWith("google_ai/")) {
    return model.slice("google_ai/".length);
  }
  if (provider === "ollama" && model.startsWith("ollama/")) {
    return model.slice("ollama/".length);
  }
  if (provider === "ollama-cloud" && model.startsWith("ollama-cloud/")) {
    return model.slice("ollama-cloud/".length);
  }
  if (provider === "lmstudio" && model.startsWith("lmstudio/")) {
    return model.slice("lmstudio/".length);
  }
  if (provider === "bedrock" && model.startsWith("bedrock/")) {
    return model.slice("bedrock/".length);
  }
  if (provider === "chatgpt-oauth" && model.startsWith("chatgpt-plus-pro/")) {
    return model.slice("chatgpt-plus-pro/".length);
  }
  return model;
}

function localProviderApiKey(
  providerName: string,
  envValue: string | undefined,
  storageDir?: string,
): string | undefined {
  return getLocalProviderApiKeyByName(providerName, storageDir) ?? envValue;
}

export interface ZaiConnection {
  apiKey?: string;
  baseURL: string;
  providerName: "zai" | "zai-coding";
}

export function resolveZaiConnection(options: {
  storageDir?: string;
  preferredProviderType?: "zai" | "zai_coding";
}): ZaiConnection {
  const regularKey =
    getLocalProviderApiKeyByName(LOCAL_ZAI_PROVIDER_NAME, options.storageDir) ??
    process.env.ZAI_API_KEY ??
    process.env.ZHIPU_API_KEY;
  const codingKey =
    getLocalProviderApiKeyByName(
      LOCAL_ZAI_CODING_PROVIDER_NAME,
      options.storageDir,
    ) ?? process.env.ZAI_CODING_API_KEY;
  const regularConnection: ZaiConnection = {
    providerName: "zai",
    baseURL: process.env.ZAI_BASE_URL ?? "https://api.z.ai/api/paas/v4",
    apiKey: regularKey,
  };
  const codingConnection: ZaiConnection = {
    providerName: "zai-coding",
    baseURL:
      process.env.ZAI_CODING_BASE_URL ?? "https://api.z.ai/api/coding/paas/v4",
    apiKey: codingKey,
  };

  if (options.preferredProviderType === "zai_coding" && codingKey) {
    return codingConnection;
  }
  if (options.preferredProviderType === "zai" && regularKey) {
    return regularConnection;
  }
  if (regularKey) return regularConnection;
  if (codingKey) return codingConnection;
  return regularConnection;
}

export function createAISDKModelFactoryFromAgent(
  model: string | undefined,
  modelSettings: AISDKModelSettings = {},
  options: Omit<AISDKModelFactoryOptions, "provider" | "model"> = {},
): () => LanguageModel {
  const provider = resolveAISDKProviderFromAgent(model, modelSettings);
  const providerType = modelSettings.provider_type;
  return createAISDKModelFactory({
    ...options,
    provider,
    model: resolveAISDKModelFromAgent(model, provider),
    ...((providerType === "zai" || providerType === "zai_coding") && {
      zaiProviderType: providerType,
    }),
  });
}

export function createAISDKModelFactory(
  options: AISDKModelFactoryOptions = {},
): () => LanguageModel {
  const provider = resolveAISDKProvider(options.provider);
  const model = options.model ?? process.env.LETTA_CODE_DEV_AI_SDK_MODEL;
  const storageDir = options.localProviderAuthStorageDir;

  switch (provider) {
    case "openai-responses":
      return createOpenAIResponsesModelFactory({
        model,
        apiKey: localProviderApiKey(
          LOCAL_OPENAI_PROVIDER_NAME,
          process.env.OPENAI_API_KEY,
          storageDir,
        ),
        createModel: options.createOpenAIResponsesModel,
      });
    case "anthropic":
      return createAnthropicModelFactory({
        model,
        apiKey: localProviderApiKey(
          LOCAL_ANTHROPIC_PROVIDER_NAME,
          process.env.ANTHROPIC_API_KEY,
          storageDir,
        ),
        createModel: options.createAnthropicModel,
      });
    case "openrouter":
      return createOpenAICompatibleModelFactory({
        model,
        providerName: "openrouter",
        baseURL:
          process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        apiKey: localProviderApiKey(
          LOCAL_OPENROUTER_PROVIDER_NAME,
          process.env.OPENROUTER_API_KEY,
          storageDir,
        ),
        headers: { "X-Title": "Letta Code" },
        createModel: options.createOpenAICompatibleModel,
      });
    case "zai": {
      const zaiConnection = resolveZaiConnection({
        storageDir,
        preferredProviderType: options.zaiProviderType,
      });
      return createOpenAICompatibleModelFactory({
        model,
        providerName: zaiConnection.providerName,
        baseURL: zaiConnection.baseURL,
        apiKey: zaiConnection.apiKey,
        createModel: options.createOpenAICompatibleModel,
      });
    }
    case "minimax":
      return createAnthropicModelFactory({
        model,
        providerName: "minimax",
        baseURL:
          process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/anthropic/v1",
        apiKey: localProviderApiKey(
          LOCAL_MINIMAX_PROVIDER_NAME,
          process.env.MINIMAX_API_KEY,
          storageDir,
        ),
        createModel: options.createAnthropicModel,
      });
    case "moonshot":
      return createOpenAICompatibleModelFactory({
        model,
        providerName: "moonshot",
        baseURL: process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1",
        apiKey:
          getLocalProviderApiKeyByName(
            LOCAL_KIMI_CODE_PROVIDER_NAME,
            storageDir,
          ) ??
          getLocalProviderApiKeyByName(
            LOCAL_MOONSHOT_PROVIDER_NAME,
            storageDir,
          ) ??
          process.env.MOONSHOT_API_KEY,
        createModel: options.createOpenAICompatibleModel,
      });
    case "google-ai":
      return createGoogleModelFactory({
        model,
        apiKey: localProviderApiKey(
          LOCAL_GOOGLE_AI_PROVIDER_NAME,
          process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
            process.env.GEMINI_API_KEY,
          storageDir,
        ),
        baseURL: process.env.GOOGLE_GENERATIVE_AI_BASE_URL,
        createModel: options.createGoogleModel,
      });
    case "ollama":
      return createOpenAICompatibleModelFactory({
        model,
        providerName: "ollama",
        baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
        apiKey: localProviderApiKey(
          LOCAL_OLLAMA_PROVIDER_NAME,
          process.env.OLLAMA_LOCAL_API_KEY ?? "not-needed",
          storageDir,
        ),
        createModel: options.createOpenAICompatibleModel,
      });
    case "ollama-cloud":
      return createOpenAICompatibleModelFactory({
        model,
        providerName: "ollama-cloud",
        baseURL: process.env.OLLAMA_CLOUD_BASE_URL ?? "https://ollama.com/v1",
        apiKey: localProviderApiKey(
          LOCAL_OLLAMA_CLOUD_PROVIDER_NAME,
          process.env.OLLAMA_API_KEY,
          storageDir,
        ),
        createModel: options.createOpenAICompatibleModel,
      });
    case "lmstudio":
      return createOpenAICompatibleModelFactory({
        model,
        providerName: "lmstudio",
        baseURL: process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1",
        apiKey: localProviderApiKey(
          LOCAL_LMSTUDIO_PROVIDER_NAME,
          process.env.LMSTUDIO_API_KEY ?? "not-needed",
          storageDir,
        ),
        createModel: options.createOpenAICompatibleModel,
      });
    case "bedrock":
      return createBedrockModelFactory({
        model,
        storageDir,
        providerName: LOCAL_BEDROCK_PROVIDER_NAME,
        createModel: options.createBedrockModel,
      });
    case "chatgpt-oauth":
      return createChatGPTOAuthModelFactory({
        model,
        storageDir,
        createModel: options.createChatGPTOAuthModel,
      });
  }
}
