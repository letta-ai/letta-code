import modelsData from "../../models.json";
import type { AISDKProvider } from "../dev/AISDKModelFactory";
import { DEFAULT_ANTHROPIC_MODEL } from "../dev/AnthropicModel";
import { DEFAULT_OPENAI_RESPONSES_MODEL } from "../dev/OpenAIResponsesModel";
import {
  LOCAL_ANTHROPIC_PROVIDER_NAME,
  LOCAL_BEDROCK_PROVIDER_NAME,
  LOCAL_CHATGPT_PROVIDER_NAME,
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

const OLLAMA_LOCAL_MODELS = [
  "ollama/llama2",
  "ollama/llama3.1:8b",
  "ollama/qwen3-coder:30b",
  "ollama/gpt-oss:20b",
];

const OLLAMA_CLOUD_MODELS = [
  "ollama-cloud/glm-4.7",
  "ollama-cloud/qwen3-coder:480b",
  "ollama-cloud/gpt-oss:20b",
  "ollama-cloud/gpt-oss:120b",
  "ollama-cloud/kimi-k2.5",
  "ollama-cloud/minimax-m2.1",
  "ollama-cloud/deepseek-v3.2",
];

const LMSTUDIO_LOCAL_MODELS = [
  "lmstudio/google/gemma-3n-e4b",
  "lmstudio/openai/gpt-oss-20b",
  "lmstudio/qwen/qwen3-30b-a3b-2507",
  "lmstudio/qwen/qwen3-coder-30b",
];

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
  const hasMinimax =
    hasEnvValue(process.env.MINIMAX_API_KEY) ||
    providers.has(LOCAL_MINIMAX_PROVIDER_NAME);
  const hasMoonshot =
    hasEnvValue(process.env.MOONSHOT_API_KEY) ||
    providers.has(LOCAL_MOONSHOT_PROVIDER_NAME) ||
    providers.has(LOCAL_KIMI_CODE_PROVIDER_NAME);
  const hasGoogleAI =
    hasEnvValue(process.env.GOOGLE_GENERATIVE_AI_API_KEY) ||
    hasEnvValue(process.env.GEMINI_API_KEY) ||
    providers.has(LOCAL_GOOGLE_AI_PROVIDER_NAME);
  const hasBedrock =
    (hasEnvValue(process.env.AWS_ACCESS_KEY_ID) &&
      hasEnvValue(process.env.AWS_SECRET_ACCESS_KEY)) ||
    providers.has(LOCAL_BEDROCK_PROVIDER_NAME);
  const hasOllama = providers.has(LOCAL_OLLAMA_PROVIDER_NAME);
  const hasOllamaCloud =
    hasEnvValue(process.env.OLLAMA_API_KEY) ||
    providers.has(LOCAL_OLLAMA_CLOUD_PROVIDER_NAME);
  const hasLMStudio =
    hasEnvValue(process.env.LMSTUDIO_API_KEY) ||
    providers.has(LOCAL_LMSTUDIO_PROVIDER_NAME);

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
    hasMinimax
  ) {
    return "minimax";
  }
  if (
    !hasOpenAIKey &&
    !hasAnthropicKey &&
    !hasOpenRouterKey &&
    !hasZaiKey &&
    !hasMinimax &&
    hasMoonshot
  ) {
    return "moonshot";
  }
  if (
    !hasOpenAIKey &&
    !hasAnthropicKey &&
    !hasOpenRouterKey &&
    !hasZaiKey &&
    !hasMinimax &&
    !hasMoonshot &&
    hasGoogleAI
  ) {
    return "google-ai";
  }
  if (
    !hasOpenAIKey &&
    !hasAnthropicKey &&
    !hasOpenRouterKey &&
    !hasZaiKey &&
    !hasMinimax &&
    !hasMoonshot &&
    !hasGoogleAI &&
    hasBedrock
  ) {
    return "bedrock";
  }
  if (
    !hasOpenAIKey &&
    !hasAnthropicKey &&
    !hasOpenRouterKey &&
    !hasZaiKey &&
    !hasMinimax &&
    !hasMoonshot &&
    !hasGoogleAI &&
    !hasBedrock &&
    hasOllama
  ) {
    return "ollama";
  }
  if (
    !hasOpenAIKey &&
    !hasAnthropicKey &&
    !hasOpenRouterKey &&
    !hasZaiKey &&
    !hasMinimax &&
    !hasMoonshot &&
    !hasGoogleAI &&
    !hasBedrock &&
    !hasOllama &&
    hasOllamaCloud
  ) {
    return "ollama-cloud";
  }
  if (
    !hasOpenAIKey &&
    !hasAnthropicKey &&
    !hasOpenRouterKey &&
    !hasZaiKey &&
    !hasMinimax &&
    !hasMoonshot &&
    !hasGoogleAI &&
    !hasBedrock &&
    !hasOllama &&
    !hasOllamaCloud &&
    hasLMStudio
  ) {
    return "lmstudio";
  }
  if (
    !hasOpenAIKey &&
    !hasAnthropicKey &&
    !hasOpenRouterKey &&
    !hasZaiKey &&
    !hasMinimax &&
    !hasMoonshot &&
    !hasGoogleAI &&
    !hasBedrock &&
    !hasOllama &&
    !hasOllamaCloud &&
    !hasLMStudio &&
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
  if (provider === "minimax") return "minimax/MiniMax-M2.7";
  if (provider === "moonshot") return "moonshot/kimi-k2.5";
  if (provider === "google-ai") return "google_ai/gemini-3.1-pro-preview";
  if (provider === "ollama") return "ollama/llama2";
  if (provider === "ollama-cloud") return "ollama-cloud/gpt-oss:20b";
  if (provider === "lmstudio") return "lmstudio/google/gemma-3n-e4b";
  if (provider === "bedrock") return "bedrock/us.anthropic.claude-sonnet-4-6";
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
  if (provider === "minimax") return `minimax/${model}`;
  if (provider === "moonshot") return `moonshot/${model}`;
  if (provider === "google-ai") return `google_ai/${model}`;
  if (provider === "ollama") return `ollama/${model}`;
  if (provider === "ollama-cloud") return `ollama-cloud/${model}`;
  if (provider === "lmstudio") return `lmstudio/${model}`;
  if (provider === "bedrock") return `bedrock/${model}`;
  if (provider === "chatgpt-oauth") return `chatgpt-plus-pro/${model}`;
  return `openai/${model}`;
}

export function localProviderType(provider: AISDKProvider): string {
  if (provider === "anthropic") return "anthropic";
  if (provider === "openrouter") return "openrouter";
  if (provider === "zai") return "zai";
  if (provider === "minimax") return "minimax";
  if (provider === "moonshot") return "moonshot";
  if (provider === "google-ai") return "google_ai";
  if (provider === "ollama") return "ollama";
  if (provider === "ollama-cloud") return "ollama_cloud";
  if (provider === "lmstudio") return "lmstudio";
  if (provider === "bedrock") return "bedrock";
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
  const hasMinimax =
    hasEnvValue(process.env.MINIMAX_API_KEY) ||
    providers.has(LOCAL_MINIMAX_PROVIDER_NAME);
  const hasMoonshot =
    hasEnvValue(process.env.MOONSHOT_API_KEY) ||
    providers.has(LOCAL_MOONSHOT_PROVIDER_NAME) ||
    providers.has(LOCAL_KIMI_CODE_PROVIDER_NAME);
  const hasGoogleAI =
    hasEnvValue(process.env.GOOGLE_GENERATIVE_AI_API_KEY) ||
    hasEnvValue(process.env.GEMINI_API_KEY) ||
    providers.has(LOCAL_GOOGLE_AI_PROVIDER_NAME);
  const hasBedrock =
    (hasEnvValue(process.env.AWS_ACCESS_KEY_ID) &&
      hasEnvValue(process.env.AWS_SECRET_ACCESS_KEY)) ||
    providers.has(LOCAL_BEDROCK_PROVIDER_NAME);
  const hasOllama = providers.has(LOCAL_OLLAMA_PROVIDER_NAME);
  const hasOllamaCloud =
    hasEnvValue(process.env.OLLAMA_API_KEY) ||
    providers.has(LOCAL_OLLAMA_CLOUD_PROVIDER_NAME);
  const hasLMStudio =
    hasEnvValue(process.env.LMSTUDIO_API_KEY) ||
    providers.has(LOCAL_LMSTUDIO_PROVIDER_NAME);

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
  if (hasMinimax) {
    for (const model of modelsData.models) {
      if (model.handle.startsWith("minimax/")) {
        addModel("minimax", model.handle);
      }
    }
  }
  if (hasMoonshot) {
    const addMoonshotModel = (model: string) => addModel("moonshot", model);
    for (const model of modelsData.models) {
      if (
        model.handle.startsWith("moonshot/") ||
        model.handle.startsWith("moonshot_coding/")
      ) {
        addMoonshotModel(model.handle);
      }
    }
    addMoonshotModel("moonshot/kimi-k2-thinking-turbo");
    addMoonshotModel("moonshot/kimi-k2-turbo-preview");
    addMoonshotModel("moonshot/kimi-k2.5");
    addMoonshotModel("moonshot/kimi-k2-0711-preview");
    addMoonshotModel("moonshot/kimi-k2-thinking");
    addMoonshotModel("moonshot/kimi-k2-0905-preview");
  }
  if (hasGoogleAI) {
    for (const model of modelsData.models) {
      if (model.handle.startsWith("google_ai/")) {
        addModel("google-ai", model.handle);
      }
    }
  }
  if (hasBedrock) {
    for (const model of modelsData.models) {
      if (model.handle.startsWith("bedrock/")) {
        addModel("bedrock", model.handle);
      }
    }
  }
  if (hasOllama) {
    for (const model of OLLAMA_LOCAL_MODELS) {
      addModel("ollama", model);
    }
  }
  if (hasOllamaCloud) {
    for (const model of OLLAMA_CLOUD_MODELS) {
      addModel("ollama-cloud", model);
    }
  }
  if (hasLMStudio) {
    for (const model of LMSTUDIO_LOCAL_MODELS) {
      addModel("lmstudio", model);
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
