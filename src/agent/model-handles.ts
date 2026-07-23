import { OPENAI_CODEX_PROVIDER_NAME } from "@/providers/openai-codex-constants";
import { models } from "./model-catalog";

export type ModelConfigSnapshot = {
  model?: string | null;
  model_endpoint_type?: string | null;
  reasoning_effort?: string | null;
  enable_reasoner?: boolean | null;
  context_window?: number | null;
  service_tier?: string | null;
};

export const LOCAL_MODEL_HANDLE_PREFIXES = [
  "ollama/",
  "ollama-cloud/",
  "lmstudio/",
  "llama.cpp/",
  "llama-cpp/",
];

export const LOCAL_CHATGPT_OAUTH_HANDLE_PREFIX = "openai-codex/";
export const CHATGPT_OAUTH_LLM_CONFIG_PROVIDER = "chatgpt_oauth";

const KNOWN_LLM_CONFIG_ENDPOINT_TYPES = new Set([
  "anthropic",
  "bedrock",
  "chatgpt_oauth",
  "google_ai",
  "google_vertex",
  "minimax",
  "moonshot",
  "moonshot_coding",
  "openai",
  "openrouter",
  "zai",
  "zai_coding",
]);

const LLM_CONFIG_ENDPOINT_TYPE_MODEL_HANDLE_PROVIDERS = new Map([
  [CHATGPT_OAUTH_LLM_CONFIG_PROVIDER, OPENAI_CODEX_PROVIDER_NAME],
  ["lmstudio", "lmstudio"],
  ["lmstudio_openai", "lmstudio"],
  ["llamacpp", "llama.cpp"],
  ["llama_cpp", "llama.cpp"],
  ["llama.cpp", "llama.cpp"],
  ["ollama_cloud", "ollama-cloud"],
]);

const MODEL_HANDLE_PROVIDER_LLM_CONFIG_ENDPOINT_TYPES = new Map([
  [OPENAI_CODEX_PROVIDER_NAME, CHATGPT_OAUTH_LLM_CONFIG_PROVIDER],
  ["openai-codex", CHATGPT_OAUTH_LLM_CONFIG_PROVIDER],
  ["lmstudio", "lmstudio"],
  ["llama.cpp", "llamacpp"],
  ["llama-cpp", "llamacpp"],
  ["ollama-cloud", "openai"],
]);

const MODEL_SETTINGS_PROVIDER_LLM_CONFIG_ENDPOINT_TYPES = new Map([
  ["lmstudio_openai", "lmstudio"],
  ["llama_cpp", "llamacpp"],
  ["llama.cpp", "llamacpp"],
  ["ollama_cloud", "openai"],
]);

export function normalizeModelHandleForRegistry(
  modelHandle: string | null | undefined,
): string | null {
  if (!modelHandle) return null;
  const [provider, ...modelParts] = modelHandle.split("/");
  const model = modelParts.join("/");
  if (provider === CHATGPT_OAUTH_LLM_CONFIG_PROVIDER && model.length > 0) {
    return `${OPENAI_CODEX_PROVIDER_NAME}/${model}`;
  }
  if (
    provider === LOCAL_CHATGPT_OAUTH_HANDLE_PREFIX.slice(0, -1) &&
    model.length > 0 &&
    !model.endsWith("-fast")
  ) {
    return `${OPENAI_CODEX_PROVIDER_NAME}/${model}`;
  }
  if (provider === "lc-anthropic" && model.length > 0) {
    return `anthropic/${model}`;
  }
  if (provider === "moonshotai" && model.length > 0) {
    return `moonshot/${model}`;
  }
  return modelHandle;
}

export function modelPortionFromHandle(modelHandle: string): string | null {
  const slashIndex = modelHandle.indexOf("/");
  if (slashIndex === -1) return null;
  return modelHandle.slice(slashIndex + 1);
}

function providerPrefix(modelHandle: string): string | null {
  const slashIndex = modelHandle.indexOf("/");
  if (slashIndex <= 0) return null;
  return modelHandle.slice(0, slashIndex);
}

const LOCAL_MODEL_PROVIDER_PREFIXES = new Set(
  LOCAL_MODEL_HANDLE_PREFIXES.map((prefix) => prefix.slice(0, -1)),
);

function isKnownModelProviderPrefix(provider: string): boolean {
  return (
    KNOWN_LLM_CONFIG_ENDPOINT_TYPES.has(provider) ||
    models.some((model) => providerPrefix(model.handle) === provider) ||
    LOCAL_MODEL_PROVIDER_PREFIXES.has(provider)
  );
}

function isKnownProviderPrefixedHandle(modelHandle: string): boolean {
  const provider = providerPrefix(modelHandle);
  return provider !== null && isKnownModelProviderPrefix(provider);
}

function modelHandleProviderForEndpointType(endpointType: string): string {
  return (
    LLM_CONFIG_ENDPOINT_TYPE_MODEL_HANDLE_PROVIDERS.get(endpointType) ??
    endpointType
  );
}

function endpointTypeMatchesModelProvider(
  endpointType: string,
  modelProvider: string,
): boolean {
  return (
    endpointType === modelProvider ||
    modelHandleProviderForEndpointType(endpointType) === modelProvider ||
    (endpointType === CHATGPT_OAUTH_LLM_CONFIG_PROVIDER &&
      modelProvider === "openai-codex") ||
    endpointType === "openai"
  );
}

function exactRegistryModelHandle(modelHandle: string): string | null {
  const registryHandle =
    normalizeModelHandleForRegistry(modelHandle) ?? modelHandle;
  return models.some((model) => model.handle === registryHandle)
    ? registryHandle
    : null;
}

function uniqueRegistryHandleForModelName(modelName: string): string | null {
  const matches = new Set(
    models
      .filter((model) => modelPortionFromHandle(model.handle) === modelName)
      .map((model) => model.handle),
  );
  return matches.size === 1 ? ([...matches][0] ?? null) : null;
}

export function normalizeKnownModelHandle(modelHandle: string): string {
  const registryHandle =
    normalizeModelHandleForRegistry(modelHandle) ?? modelHandle;
  const exact = exactRegistryModelHandle(registryHandle);
  if (exact) return exact;

  const model = modelPortionFromHandle(registryHandle);
  if (!model) {
    return uniqueRegistryHandleForModelName(registryHandle) ?? registryHandle;
  }

  const provider = providerPrefix(registryHandle);
  if (provider && !isKnownModelProviderPrefix(provider)) {
    return registryHandle;
  }

  return uniqueRegistryHandleForModelName(model) ?? registryHandle;
}

export function resolveModelHandleFromLlmConfig(
  llmConfig: ModelConfigSnapshot | null | undefined,
): string | null {
  if (!llmConfig?.model) return null;

  const model = llmConfig.model;
  const endpointType = llmConfig.model_endpoint_type;
  if (endpointType) {
    const normalizedModel = normalizeModelHandleForRegistry(model) ?? model;
    const modelProvider = providerPrefix(normalizedModel);
    if (
      modelProvider &&
      isKnownModelProviderPrefix(modelProvider) &&
      endpointTypeMatchesModelProvider(endpointType, modelProvider)
    ) {
      return normalizeKnownModelHandle(normalizedModel);
    }

    return normalizeKnownModelHandle(
      `${modelHandleProviderForEndpointType(endpointType)}/${model}`,
    );
  }

  const normalizedModel = normalizeKnownModelHandle(model);
  if (
    normalizedModel !== model ||
    exactRegistryModelHandle(normalizedModel) ||
    isKnownProviderPrefixedHandle(normalizedModel)
  ) {
    return normalizedModel;
  }

  return model;
}

function endpointTypeForModelHandleProvider(provider: string): string | null {
  const alias = MODEL_HANDLE_PROVIDER_LLM_CONFIG_ENDPOINT_TYPES.get(provider);
  if (alias) return alias;
  if (KNOWN_LLM_CONFIG_ENDPOINT_TYPES.has(provider)) return provider;
  if (LOCAL_MODEL_PROVIDER_PREFIXES.has(provider)) return provider;
  return null;
}

function endpointTypeForModelHandle(
  provider: string,
  providerType: string | null | undefined,
): string | null {
  const inferred = endpointTypeForModelHandleProvider(provider);
  if (!providerType) return inferred;
  const compatibleProviderType =
    MODEL_SETTINGS_PROVIDER_LLM_CONFIG_ENDPOINT_TYPES.get(providerType) ??
    providerType;
  if (!isKnownModelProviderPrefix(provider)) return compatibleProviderType;
  if (providerType === "openai" && provider !== "openai") return inferred;
  return endpointTypeMatchesModelProvider(providerType, provider)
    ? compatibleProviderType
    : inferred;
}

export function mapModelHandleToLlmConfigPatch(
  modelHandle: string,
  providerType?: string | null,
): Pick<ModelConfigSnapshot, "model" | "model_endpoint_type"> {
  const normalizedHandle = normalizeKnownModelHandle(modelHandle);
  const provider = providerPrefix(normalizedHandle);
  const model = modelPortionFromHandle(normalizedHandle);
  if (!provider || !model) {
    return { model: normalizedHandle };
  }

  const endpointType = endpointTypeForModelHandle(provider, providerType);
  if (!endpointType) {
    return { model: normalizedHandle };
  }

  const compatibleModel =
    endpointType === "openai" && provider !== "openai"
      ? normalizedHandle
      : model;
  return { model: compatibleModel, model_endpoint_type: endpointType };
}
