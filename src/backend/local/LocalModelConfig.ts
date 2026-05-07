import modelsData from "../../models.json";
import type { AISDKProvider } from "../dev/AISDKModelFactory";
import { DEFAULT_ANTHROPIC_MODEL } from "../dev/AnthropicModel";
import { DEFAULT_OPENAI_RESPONSES_MODEL } from "../dev/OpenAIResponsesModel";
import {
  LOCAL_ANTHROPIC_PROVIDER_NAME,
  LOCAL_CHATGPT_PROVIDER_NAME,
  LOCAL_OPENAI_PROVIDER_NAME,
  LOCAL_OPENROUTER_PROVIDER_NAME,
  LOCAL_ZAI_CODING_PROVIDER_NAME,
  LOCAL_ZAI_PROVIDER_NAME,
  listLocalProviderRecords,
} from "./LocalProviderAuthStore";

export interface LocalModelConfig {
  provider: AISDKProvider;
  model: string;
  handle: string;
  modelSettings: Record<string, unknown>;
}

interface LocalModelListEntry {
  handle: string;
  model: string;
  model_endpoint_type: string;
}

function hasEnvValue(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0;
}

function localProviderNames(storageDir?: string): Set<string> {
  return new Set(
    listLocalProviderRecords(storageDir).map((record) => record.name),
  );
}

function inferLocalProviderFromStandardKeys(
  storageDir?: string,
): AISDKProvider {
  const providers = localProviderNames(storageDir);
  const hasOpenAIKey =
    hasEnvValue(process.env.OPENAI_API_KEY) ||
    providers.has(LOCAL_OPENAI_PROVIDER_NAME);
  const hasAnthropicKey =
    hasEnvValue(process.env.ANTHROPIC_API_KEY) ||
    providers.has(LOCAL_ANTHROPIC_PROVIDER_NAME);
  const hasOpenRouterKey =
    hasEnvValue(process.env.OPENROUTER_API_KEY) ||
    providers.has(LOCAL_OPENROUTER_PROVIDER_NAME);
  const hasZaiKey =
    hasEnvValue(process.env.ZAI_API_KEY) ||
    hasEnvValue(process.env.ZHIPU_API_KEY) ||
    providers.has(LOCAL_ZAI_PROVIDER_NAME) ||
    providers.has(LOCAL_ZAI_CODING_PROVIDER_NAME);
  const hasChatGPT = providers.has(LOCAL_CHATGPT_PROVIDER_NAME);

  if (!hasOpenAIKey && hasAnthropicKey) return "anthropic";
  if (!hasOpenAIKey && !hasAnthropicKey && hasOpenRouterKey) {
    return "openrouter";
  }
  if (!hasOpenAIKey && !hasAnthropicKey && !hasOpenRouterKey && hasZaiKey) {
    return "zai";
  }
  if (
    !hasOpenAIKey &&
    !hasAnthropicKey &&
    !hasOpenRouterKey &&
    !hasZaiKey &&
    hasChatGPT
  ) {
    return "chatgpt-oauth";
  }
  return "openai-responses";
}

export function resolveLocalProvider(storageDir?: string): AISDKProvider {
  return inferLocalProviderFromStandardKeys(storageDir);
}

export function resolveLocalModel(provider = resolveLocalProvider()): string {
  if (provider === "anthropic") return DEFAULT_ANTHROPIC_MODEL;
  if (provider === "openrouter") return "openrouter/deepseek/deepseek-v4-pro";
  if (provider === "zai") return "zai/glm-5.1";
  if (provider === "chatgpt-oauth") {
    return `chatgpt-plus-pro/${DEFAULT_OPENAI_RESPONSES_MODEL}`;
  }
  return DEFAULT_OPENAI_RESPONSES_MODEL;
}

export function localModelHandle(
  provider: AISDKProvider,
  model: string,
): string {
  if (model.includes("/")) return model;
  if (provider === "anthropic") return `anthropic/${model}`;
  if (provider === "openrouter") return `openrouter/${model}`;
  if (provider === "zai") return `zai/${model}`;
  if (provider === "chatgpt-oauth") return `chatgpt-plus-pro/${model}`;
  return `openai/${model}`;
}

export function localProviderType(provider: AISDKProvider): string {
  if (provider === "anthropic") return "anthropic";
  if (provider === "openrouter") return "openrouter";
  if (provider === "zai") return "zai";
  if (provider === "chatgpt-oauth") return "chatgpt_oauth";
  return "openai";
}

export function resolveLocalModelConfig(storageDir?: string): LocalModelConfig {
  const provider = resolveLocalProvider(storageDir);
  const model = resolveLocalModel(provider);
  return {
    provider,
    model,
    handle: localModelHandle(provider, model),
    modelSettings: { provider_type: localProviderType(provider) },
  };
}

export function listLocalModels(storageDir?: string) {
  const configured = resolveLocalModelConfig(storageDir);
  const openAIModel = DEFAULT_OPENAI_RESPONSES_MODEL;
  const anthropicModel = DEFAULT_ANTHROPIC_MODEL;
  const models: LocalModelListEntry[] = [];
  const addModel = (provider: AISDKProvider, model: string) => {
    const handle = localModelHandle(provider, model);
    if (models.some((entry) => entry.handle === handle)) return;
    models.push({
      handle,
      model: handle,
      model_endpoint_type: localProviderType(provider),
    });
  };

  addModel(configured.provider, configured.model);
  const providers = localProviderNames(storageDir);
  const hasOpenAI =
    hasEnvValue(process.env.OPENAI_API_KEY) ||
    providers.has(LOCAL_OPENAI_PROVIDER_NAME);
  const hasAnthropic =
    hasEnvValue(process.env.ANTHROPIC_API_KEY) ||
    providers.has(LOCAL_ANTHROPIC_PROVIDER_NAME);
  const hasOpenRouter =
    hasEnvValue(process.env.OPENROUTER_API_KEY) ||
    providers.has(LOCAL_OPENROUTER_PROVIDER_NAME);
  const hasZai =
    hasEnvValue(process.env.ZAI_API_KEY) ||
    hasEnvValue(process.env.ZHIPU_API_KEY) ||
    providers.has(LOCAL_ZAI_PROVIDER_NAME) ||
    providers.has(LOCAL_ZAI_CODING_PROVIDER_NAME);
  const hasChatGPT = providers.has(LOCAL_CHATGPT_PROVIDER_NAME);

  if (hasOpenAI) {
    addModel("openai-responses", openAIModel);
    for (const model of modelsData.models) {
      if (model.handle.startsWith("openai/")) {
        addModel("openai-responses", model.handle);
      }
    }
  }
  if (hasAnthropic) {
    addModel("anthropic", anthropicModel);
    for (const model of modelsData.models) {
      if (model.handle.startsWith("anthropic/")) {
        addModel("anthropic", model.handle);
      }
    }
  }
  if (hasOpenRouter) {
    for (const model of modelsData.models) {
      if (model.handle.startsWith("openrouter/")) {
        addModel("openrouter", model.handle);
      }
    }
  }
  if (hasZai) {
    for (const model of modelsData.models) {
      if (model.handle.startsWith("zai/")) {
        addModel("zai", model.handle);
      }
    }
  }
  if (hasChatGPT) {
    for (const model of modelsData.models) {
      if (model.handle.startsWith("chatgpt-plus-pro/")) {
        addModel("chatgpt-oauth", model.handle);
      }
    }
  }
  return models;
}
