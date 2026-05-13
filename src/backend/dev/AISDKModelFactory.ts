import type { LanguageModel } from "ai";
import {
  getLocalProviderApiKeyByName,
  getLocalProviderBaseUrlByName,
} from "../local/LocalProviderAuthStore";
import {
  type AISDKProvider,
  expectedAISDKProviderList,
  getAISDKProviderSpec,
  isAISDKProvider,
  LOCAL_ZAI_CODING_PROVIDER_NAME,
  LOCAL_ZAI_PROVIDER_NAME,
  resolveProviderFromModelHandle,
  resolveProviderFromProviderType,
  stripProviderHandlePrefix,
} from "./AISDKProviderRegistry";
import { createAnthropicModelFactory } from "./AnthropicModel";
import { createBedrockModelFactory } from "./BedrockModel";
import { createChatGPTOAuthModelFactory } from "./ChatGPTOAuthModel";
import { createGoogleModelFactory } from "./GoogleModel";
import { createOpenAICompatibleModelFactory } from "./OpenAICompatibleModel";
import { createOpenAIResponsesModelFactory } from "./OpenAIResponsesModel";

export const DEFAULT_AI_SDK_PROVIDER = "openai-responses";
export type { AISDKProvider } from "./AISDKProviderRegistry";

export interface AISDKModelFactoryOptions {
  provider?: string;
  model?: string;
  createOpenAIResponsesModel?: (model: string) => LanguageModel;
  createAnthropicModel?: (model: string) => LanguageModel;
  createOpenAICompatibleModel?: (
    model: string,
    options: {
      apiKey?: string;
      baseURL: string;
      providerName: string;
      headers?: Record<string, string>;
    },
  ) => LanguageModel;
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
  if (isAISDKProvider(provider)) {
    return provider;
  }
  throw new Error(
    `Unknown AI SDK provider "${provider}". Expected ${expectedAISDKProviderList()}.`,
  );
}

export function resolveAISDKProviderFromAgent(
  model: string | undefined,
  modelSettings: AISDKModelSettings = {},
): AISDKProvider {
  return (
    resolveProviderFromModelHandle(model) ??
    resolveProviderFromProviderType(modelSettings.provider_type) ??
    resolveAISDKProvider()
  );
}

export function resolveAISDKModelFromAgent(
  model: string | undefined,
  provider: AISDKProvider,
): string | undefined {
  return stripProviderHandlePrefix(model, provider);
}

function localProviderApiKey(
  providerNames: readonly string[],
  envValue: string | undefined,
  storageDir?: string,
): string | undefined {
  for (const providerName of providerNames) {
    const key = getLocalProviderApiKeyByName(providerName, storageDir);
    if (key) return key;
  }
  return envValue;
}

function localProviderBaseURL(
  providerNames: readonly string[],
  envValue: string | undefined,
  storageDir?: string,
): string | undefined {
  for (const providerName of providerNames) {
    const baseURL = getLocalProviderBaseUrlByName(providerName, storageDir);
    if (baseURL) return baseURL;
  }
  return envValue;
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
  const spec = getAISDKProviderSpec(provider);
  const model = options.model ?? process.env.LETTA_CODE_DEV_AI_SDK_MODEL;
  const storageDir = options.localProviderAuthStorageDir;
  const apiKey = localProviderApiKey(
    spec.localProviderNames,
    spec.apiKeyEnv?.() ?? spec.fallbackApiKey,
    storageDir,
  );
  const baseURL = localProviderBaseURL(
    spec.localProviderNames,
    spec.baseURL?.(),
    storageDir,
  );

  switch (spec.sdk) {
    case "openai-responses":
      return createOpenAIResponsesModelFactory({
        model,
        apiKey,
        createModel: options.createOpenAIResponsesModel,
      });
    case "anthropic":
      return createAnthropicModelFactory({
        model,
        providerName: spec.providerName,
        baseURL,
        apiKey,
        createModel: options.createAnthropicModel,
      });
    case "openai-compatible": {
      if (provider === "zai") {
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
      return createOpenAICompatibleModelFactory({
        model,
        providerName: spec.providerName ?? provider,
        baseURL: baseURL ?? "",
        apiKey,
        headers: spec.headers?.(),
        createModel: options.createOpenAICompatibleModel,
      });
    }
    case "google":
      return createGoogleModelFactory({
        model,
        apiKey,
        baseURL,
        createModel: options.createGoogleModel,
      });
    case "bedrock":
      return createBedrockModelFactory({
        model,
        storageDir,
        providerName: spec.localProviderNames[0] ?? "lc-bedrock",
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
