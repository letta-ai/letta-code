import type { AISDKProvider } from "../dev/AISDKModelFactory";
import { DEFAULT_ANTHROPIC_MODEL } from "../dev/AnthropicModel";
import { DEFAULT_OPENAI_RESPONSES_MODEL } from "../dev/OpenAIResponsesModel";

export interface LocalModelConfig {
  provider: AISDKProvider;
  model: string;
  handle: string;
  modelSettings: Record<string, unknown>;
}

function localProviderEnv(): string | undefined {
  return (
    process.env.LETTA_LOCAL_AI_PROVIDER ??
    process.env.LETTA_CODE_DEV_AI_SDK_PROVIDER
  );
}

function localModelEnv(provider: AISDKProvider): string | undefined {
  return (
    process.env.LETTA_LOCAL_AI_MODEL ??
    (provider === "anthropic"
      ? process.env.LETTA_LOCAL_ANTHROPIC_MODEL
      : process.env.LETTA_LOCAL_OPENAI_MODEL) ??
    process.env.LETTA_CODE_DEV_AI_SDK_MODEL
  );
}

export function resolveLocalProvider(): AISDKProvider {
  const provider = localProviderEnv() ?? "openai-responses";
  if (provider === "openai" || provider === "openai-responses") {
    return "openai-responses";
  }
  if (provider === "anthropic") return "anthropic";
  throw new Error(
    `Unknown local AI provider "${provider}". Expected "openai-responses" or "anthropic".`,
  );
}

export function resolveLocalModel(provider = resolveLocalProvider()): string {
  return (
    localModelEnv(provider) ??
    (provider === "anthropic"
      ? DEFAULT_ANTHROPIC_MODEL
      : DEFAULT_OPENAI_RESPONSES_MODEL)
  );
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
  const openAIModel =
    process.env.LETTA_LOCAL_OPENAI_MODEL ?? DEFAULT_OPENAI_RESPONSES_MODEL;
  const anthropicModel =
    process.env.LETTA_LOCAL_ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
  const models = [
    {
      handle: localModelHandle("openai-responses", openAIModel),
      model: localModelHandle("openai-responses", openAIModel),
      model_endpoint_type: "openai",
    },
    {
      handle: localModelHandle("anthropic", anthropicModel),
      model: localModelHandle("anthropic", anthropicModel),
      model_endpoint_type: "anthropic",
    },
  ];
  if (!models.some((model) => model.handle === configured.handle)) {
    models.unshift({
      handle: configured.handle,
      model: configured.handle,
      model_endpoint_type: localProviderType(configured.provider),
    });
  }
  return models;
}
