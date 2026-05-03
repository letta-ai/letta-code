import modelsData from "../../models.json";
import type { AISDKProvider } from "../dev/AISDKModelFactory";
import { DEFAULT_ANTHROPIC_MODEL } from "../dev/AnthropicModel";
import { DEFAULT_OPENAI_RESPONSES_MODEL } from "../dev/OpenAIResponsesModel";

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

function inferLocalProviderFromStandardKeys(): AISDKProvider {
  const hasOpenAIKey = hasEnvValue(process.env.OPENAI_API_KEY);
  const hasAnthropicKey = hasEnvValue(process.env.ANTHROPIC_API_KEY);

  if (!hasOpenAIKey && hasAnthropicKey) return "anthropic";
  return "openai-responses";
}

export function resolveLocalProvider(): AISDKProvider {
  return inferLocalProviderFromStandardKeys();
}

export function resolveLocalModel(provider = resolveLocalProvider()): string {
  return provider === "anthropic"
    ? DEFAULT_ANTHROPIC_MODEL
    : DEFAULT_OPENAI_RESPONSES_MODEL;
}

export function localModelHandle(
  provider: AISDKProvider,
  model: string,
): string {
  if (model.includes("/")) return model;
  return provider === "anthropic" ? `anthropic/${model}` : `openai/${model}`;
}

export function localProviderType(provider: AISDKProvider): string {
  return provider === "anthropic" ? "anthropic" : "openai";
}

export function resolveLocalModelConfig(): LocalModelConfig {
  const provider = resolveLocalProvider();
  const model = resolveLocalModel(provider);
  return {
    provider,
    model,
    handle: localModelHandle(provider, model),
    modelSettings: { provider_type: localProviderType(provider) },
  };
}

export function listLocalModels() {
  const configured = resolveLocalModelConfig();
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
  if (hasEnvValue(process.env.OPENAI_API_KEY)) {
    addModel("openai-responses", openAIModel);
    for (const model of modelsData.models) {
      if (model.handle.startsWith("openai/")) {
        addModel("openai-responses", model.handle);
      }
    }
  }
  if (hasEnvValue(process.env.ANTHROPIC_API_KEY)) {
    addModel("anthropic", anthropicModel);
    for (const model of modelsData.models) {
      if (model.handle.startsWith("anthropic/")) {
        addModel("anthropic", model.handle);
      }
    }
  }
  return models;
}
