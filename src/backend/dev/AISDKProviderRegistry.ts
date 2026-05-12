import modelsData from "../../models.json";
import { DEFAULT_ANTHROPIC_MODEL } from "./AnthropicModel";
import { DEFAULT_OPENAI_RESPONSES_MODEL } from "./OpenAIResponsesModel";

export const LOCAL_CHATGPT_PROVIDER_NAME = "chatgpt-plus-pro";
export const LOCAL_OPENAI_PROVIDER_NAME = "lc-openai";
export const LOCAL_ANTHROPIC_PROVIDER_NAME = "lc-anthropic";
export const LOCAL_OPENROUTER_PROVIDER_NAME = "lc-openrouter";
export const LOCAL_OLLAMA_PROVIDER_NAME = "lc-ollama";
export const LOCAL_OLLAMA_CLOUD_PROVIDER_NAME = "lc-ollama-cloud";
export const LOCAL_LMSTUDIO_PROVIDER_NAME = "lc-lmstudio";
export const LOCAL_ZAI_PROVIDER_NAME = "lc-zai";
export const LOCAL_ZAI_CODING_PROVIDER_NAME = "lc-zai-coding";
export const LOCAL_MINIMAX_PROVIDER_NAME = "lc-minimax";
export const LOCAL_MOONSHOT_PROVIDER_NAME = "lc-moonshot";
export const LOCAL_KIMI_CODE_PROVIDER_NAME = "lc-kimi-code";
export const LOCAL_GOOGLE_AI_PROVIDER_NAME = "lc-gemini";
export const LOCAL_BEDROCK_PROVIDER_NAME = "lc-bedrock";

const OLLAMA_LOCAL_MODELS = [
  "ollama/llama2",
  "ollama/llama3.1:8b",
  "ollama/qwen3-coder:30b",
  "ollama/gpt-oss:20b",
] as const;

const OLLAMA_CLOUD_MODELS = [
  "ollama-cloud/glm-4.7",
  "ollama-cloud/qwen3-coder:480b",
  "ollama-cloud/gpt-oss:20b",
  "ollama-cloud/gpt-oss:120b",
  "ollama-cloud/kimi-k2.5",
  "ollama-cloud/minimax-m2.1",
  "ollama-cloud/deepseek-v3.2",
] as const;

const LMSTUDIO_LOCAL_MODELS = [
  "lmstudio/google/gemma-3n-e4b",
  "lmstudio/openai/gpt-oss-20b",
  "lmstudio/qwen/qwen3-30b-a3b-2507",
  "lmstudio/qwen/qwen3-coder-30b",
] as const;

const MOONSHOT_MODELS = [
  "moonshot/kimi-k2-thinking-turbo",
  "moonshot/kimi-k2-turbo-preview",
  "moonshot/kimi-k2.5",
  "moonshot/kimi-k2-0711-preview",
  "moonshot/kimi-k2-thinking",
  "moonshot/kimi-k2-0905-preview",
] as const;

function hasEnvValue(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0;
}

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

export type AISDKProviderKind = "anthropic" | "openai" | "unknown";

export type AISDKProviderSDK =
  | "openai-responses"
  | "anthropic"
  | "openai-compatible"
  | "google"
  | "bedrock"
  | "chatgpt-oauth";

export interface AISDKProviderSpec {
  id: AISDKProvider;
  sdk: AISDKProviderSDK;
  providerName?: string;
  providerTypes: readonly string[];
  handlePrefixes: readonly string[];
  localProviderNames: readonly string[];
  defaultModel: string;
  baseURL?: () => string | undefined;
  apiKeyEnv?: () => string | undefined;
  fallbackApiKey?: string;
  headers?: () => Record<string, string> | undefined;
  catalogPrefixes?: readonly string[];
  staticModels?: readonly string[];
  providerOptionsKind: AISDKProviderKind;
  envConfigured?: () => boolean;
  catalogModelHandle?: (modelHandle: string) => string | undefined;
}

function defaultCatalogModelHandle(
  prefixes: readonly string[],
): (modelHandle: string) => string | undefined {
  return (modelHandle) =>
    prefixes.some((prefix) => modelHandle.startsWith(prefix))
      ? modelHandle
      : undefined;
}

export const AISDK_PROVIDER_SPECS = [
  {
    id: "openai-responses",
    sdk: "openai-responses",
    providerTypes: ["openai", "openai-responses"],
    handlePrefixes: ["openai/", "openai-responses/"],
    localProviderNames: [LOCAL_OPENAI_PROVIDER_NAME],
    defaultModel: DEFAULT_OPENAI_RESPONSES_MODEL,
    catalogPrefixes: ["openai/"],
    providerOptionsKind: "openai",
    apiKeyEnv: () => process.env.OPENAI_API_KEY,
    envConfigured: () => hasEnvValue(process.env.OPENAI_API_KEY),
  },
  {
    id: "anthropic",
    sdk: "anthropic",
    providerTypes: ["anthropic"],
    handlePrefixes: ["anthropic/"],
    localProviderNames: [LOCAL_ANTHROPIC_PROVIDER_NAME],
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
    catalogPrefixes: ["anthropic/"],
    providerOptionsKind: "anthropic",
    apiKeyEnv: () => process.env.ANTHROPIC_API_KEY,
    envConfigured: () => hasEnvValue(process.env.ANTHROPIC_API_KEY),
  },
  {
    id: "openrouter",
    sdk: "openai-compatible",
    providerName: "openrouter",
    providerTypes: ["openrouter"],
    handlePrefixes: ["openrouter/"],
    localProviderNames: [LOCAL_OPENROUTER_PROVIDER_NAME],
    defaultModel: "openrouter/deepseek/deepseek-v4-pro",
    catalogPrefixes: ["openrouter/"],
    providerOptionsKind: "unknown",
    baseURL: () =>
      process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKeyEnv: () => process.env.OPENROUTER_API_KEY,
    headers: () => ({ "X-Title": "Letta Code" }),
    envConfigured: () => hasEnvValue(process.env.OPENROUTER_API_KEY),
  },
  {
    id: "zai",
    sdk: "openai-compatible",
    providerName: "zai",
    providerTypes: ["zai", "zai_coding"],
    handlePrefixes: ["zai/"],
    localProviderNames: [
      LOCAL_ZAI_PROVIDER_NAME,
      LOCAL_ZAI_CODING_PROVIDER_NAME,
    ],
    defaultModel: "zai/glm-5.1",
    catalogPrefixes: ["zai/"],
    providerOptionsKind: "unknown",
    envConfigured: () =>
      hasEnvValue(process.env.ZAI_API_KEY) ||
      hasEnvValue(process.env.ZHIPU_API_KEY) ||
      hasEnvValue(process.env.ZAI_CODING_API_KEY),
  },
  {
    id: "minimax",
    sdk: "anthropic",
    providerName: "minimax",
    providerTypes: ["minimax"],
    handlePrefixes: ["minimax/"],
    localProviderNames: [LOCAL_MINIMAX_PROVIDER_NAME],
    defaultModel: "minimax/MiniMax-M2.7",
    catalogPrefixes: ["minimax/"],
    providerOptionsKind: "unknown",
    baseURL: () =>
      process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/anthropic/v1",
    apiKeyEnv: () => process.env.MINIMAX_API_KEY,
    envConfigured: () => hasEnvValue(process.env.MINIMAX_API_KEY),
  },
  {
    id: "moonshot",
    sdk: "openai-compatible",
    providerName: "moonshot",
    providerTypes: ["moonshot", "moonshot_coding"],
    handlePrefixes: ["moonshot/", "moonshot_coding/"],
    localProviderNames: [
      LOCAL_KIMI_CODE_PROVIDER_NAME,
      LOCAL_MOONSHOT_PROVIDER_NAME,
    ],
    defaultModel: "moonshot/kimi-k2.5",
    staticModels: MOONSHOT_MODELS,
    providerOptionsKind: "unknown",
    baseURL: () =>
      process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1",
    apiKeyEnv: () => process.env.MOONSHOT_API_KEY,
    envConfigured: () => hasEnvValue(process.env.MOONSHOT_API_KEY),
  },
  {
    id: "google-ai",
    sdk: "google",
    providerTypes: ["google_ai"],
    handlePrefixes: ["google_ai/"],
    localProviderNames: [LOCAL_GOOGLE_AI_PROVIDER_NAME],
    defaultModel: "google_ai/gemini-3.1-pro-preview",
    catalogPrefixes: ["google_ai/"],
    providerOptionsKind: "unknown",
    baseURL: () => process.env.GOOGLE_GENERATIVE_AI_BASE_URL,
    apiKeyEnv: () =>
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY,
    envConfigured: () =>
      hasEnvValue(process.env.GOOGLE_GENERATIVE_AI_API_KEY) ||
      hasEnvValue(process.env.GEMINI_API_KEY),
  },
  {
    id: "bedrock",
    sdk: "bedrock",
    providerTypes: ["bedrock"],
    handlePrefixes: ["bedrock/"],
    localProviderNames: [LOCAL_BEDROCK_PROVIDER_NAME],
    defaultModel: "bedrock/us.anthropic.claude-sonnet-4-6",
    catalogPrefixes: ["bedrock/"],
    providerOptionsKind: "unknown",
    envConfigured: () =>
      (hasEnvValue(process.env.AWS_ACCESS_KEY_ID) &&
        hasEnvValue(process.env.AWS_SECRET_ACCESS_KEY)) ||
      hasEnvValue(process.env.AWS_PROFILE) ||
      hasEnvValue(process.env.AWS_BEARER_TOKEN_BEDROCK),
  },
  {
    id: "ollama",
    sdk: "openai-compatible",
    providerName: "ollama",
    providerTypes: ["ollama"],
    handlePrefixes: ["ollama/"],
    localProviderNames: [LOCAL_OLLAMA_PROVIDER_NAME],
    defaultModel: "ollama/llama2",
    staticModels: OLLAMA_LOCAL_MODELS,
    providerOptionsKind: "unknown",
    baseURL: () => process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
    apiKeyEnv: () => process.env.OLLAMA_LOCAL_API_KEY,
    fallbackApiKey: "not-needed",
  },
  {
    id: "ollama-cloud",
    sdk: "openai-compatible",
    providerName: "ollama-cloud",
    providerTypes: ["ollama_cloud"],
    handlePrefixes: ["ollama-cloud/"],
    localProviderNames: [LOCAL_OLLAMA_CLOUD_PROVIDER_NAME],
    defaultModel: "ollama-cloud/gpt-oss:20b",
    staticModels: OLLAMA_CLOUD_MODELS,
    providerOptionsKind: "unknown",
    baseURL: () => process.env.OLLAMA_CLOUD_BASE_URL ?? "https://ollama.com/v1",
    apiKeyEnv: () => process.env.OLLAMA_API_KEY,
    envConfigured: () => hasEnvValue(process.env.OLLAMA_API_KEY),
  },
  {
    id: "lmstudio",
    sdk: "openai-compatible",
    providerName: "lmstudio",
    providerTypes: ["lmstudio"],
    handlePrefixes: ["lmstudio/"],
    localProviderNames: [LOCAL_LMSTUDIO_PROVIDER_NAME],
    defaultModel: "lmstudio/google/gemma-3n-e4b",
    staticModels: LMSTUDIO_LOCAL_MODELS,
    providerOptionsKind: "unknown",
    baseURL: () => process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1",
    apiKeyEnv: () => process.env.LMSTUDIO_API_KEY,
    fallbackApiKey: "not-needed",
    envConfigured: () => hasEnvValue(process.env.LMSTUDIO_API_KEY),
  },
  {
    id: "chatgpt-oauth",
    sdk: "chatgpt-oauth",
    providerTypes: ["chatgpt_oauth"],
    handlePrefixes: ["chatgpt-plus-pro/"],
    localProviderNames: [LOCAL_CHATGPT_PROVIDER_NAME],
    defaultModel: `chatgpt-plus-pro/${DEFAULT_OPENAI_RESPONSES_MODEL}`,
    providerOptionsKind: "openai",
    catalogModelHandle: (modelHandle) =>
      modelHandle.startsWith("openai/")
        ? `chatgpt-plus-pro/${modelHandle.slice("openai/".length)}`
        : undefined,
  },
] as const satisfies readonly AISDKProviderSpec[];

export const SUPPORTED_LOCAL_PROVIDER_TYPES: ReadonlySet<string> = new Set(
  AISDK_PROVIDER_SPECS.flatMap((provider) => provider.providerTypes),
);

export const KNOWN_AISDK_PROVIDERS = new Set(
  AISDK_PROVIDER_SPECS.map((provider) => provider.id),
);

export const PROVIDER_TYPE_TO_BASE_PROVIDER = Object.fromEntries(
  AISDK_PROVIDER_SPECS.flatMap((provider) =>
    provider.providerTypes.map((providerType) => [
      providerType,
      provider.handlePrefixes[0]?.slice(0, -1) ?? provider.id,
    ]),
  ),
) as Record<string, string>;

export function getAISDKProviderSpec(
  provider: AISDKProvider,
): AISDKProviderSpec {
  const spec = AISDK_PROVIDER_SPECS.find((entry) => entry.id === provider);
  if (!spec) {
    throw new Error(`Unknown AI SDK provider "${provider}".`);
  }
  return spec;
}

export function isAISDKProvider(provider: string): provider is AISDKProvider {
  return KNOWN_AISDK_PROVIDERS.has(provider as AISDKProvider);
}

export function expectedAISDKProviderList(): string {
  return AISDK_PROVIDER_SPECS.map((provider) => `"${provider.id}"`).join(", ");
}

export function resolveProviderFromModelHandle(
  model: string | undefined,
): AISDKProvider | undefined {
  if (!model) return undefined;
  return AISDK_PROVIDER_SPECS.find((provider) =>
    provider.handlePrefixes.some((prefix) => model.startsWith(prefix)),
  )?.id;
}

export function resolveProviderFromProviderType(
  providerType: unknown,
): AISDKProvider | undefined {
  if (typeof providerType !== "string") return undefined;
  return AISDK_PROVIDER_SPECS.find((provider) =>
    (provider.providerTypes as readonly string[]).includes(providerType),
  )?.id;
}

export function stripProviderHandlePrefix(
  model: string | undefined,
  provider: AISDKProvider,
): string | undefined {
  if (!model) return process.env.LETTA_CODE_DEV_AI_SDK_MODEL;
  const spec = getAISDKProviderSpec(provider);
  const prefix = spec.handlePrefixes.find((prefix) => model.startsWith(prefix));
  return prefix ? model.slice(prefix.length) : model;
}

export function hasKnownProviderHandlePrefix(model: string): boolean {
  return AISDK_PROVIDER_SPECS.some((provider) =>
    provider.handlePrefixes.some((prefix) => model.startsWith(prefix)),
  );
}

export function localProviderType(provider: AISDKProvider): string {
  return getAISDKProviderSpec(provider).providerTypes[0] ?? "openai";
}

export function localModelHandle(
  provider: AISDKProvider,
  model: string,
): string {
  if (hasKnownProviderHandlePrefix(model)) return model;
  const prefix = getAISDKProviderSpec(provider).handlePrefixes[0];
  return prefix ? `${prefix}${model}` : model;
}

export function resolveLocalModel(provider: AISDKProvider): string {
  return getAISDKProviderSpec(provider).defaultModel;
}

export function isProviderConfigured(
  provider: AISDKProviderSpec,
  localProviderNames: Set<string>,
): boolean {
  return (
    provider.localProviderNames.some((name) => localProviderNames.has(name)) ||
    Boolean(provider.envConfigured?.())
  );
}

export function listConfiguredAISDKProviders(
  localProviderNames: Set<string>,
): AISDKProvider[] {
  return AISDK_PROVIDER_SPECS.filter((provider) =>
    isProviderConfigured(provider, localProviderNames),
  ).map((provider) => provider.id);
}

export function listCatalogModelsForProvider(
  provider: AISDKProvider,
): string[] {
  const spec = getAISDKProviderSpec(provider);
  const seen = new Set<string>();
  const models: string[] = [];
  const add = (model: string | undefined) => {
    if (!model || seen.has(model)) return;
    seen.add(model);
    models.push(model);
  };

  add(spec.defaultModel);
  const mapCatalogModel =
    spec.catalogModelHandle ??
    (spec.catalogPrefixes
      ? defaultCatalogModelHandle(spec.catalogPrefixes)
      : undefined);
  if (mapCatalogModel) {
    for (const model of modelsData.models) {
      add(mapCatalogModel(model.handle));
    }
  }
  for (const model of spec.staticModels ?? []) {
    add(model);
  }

  return models;
}

export function aiSDKProviderKindFromModel(
  modelHandle: string,
  modelSettings: Record<string, unknown>,
): AISDKProviderKind {
  const providerFromModel = resolveProviderFromModelHandle(modelHandle);
  if (providerFromModel) {
    return getAISDKProviderSpec(providerFromModel).providerOptionsKind;
  }
  const providerFromSettings = resolveProviderFromProviderType(
    modelSettings.provider_type,
  );
  if (providerFromSettings) {
    return getAISDKProviderSpec(providerFromSettings).providerOptionsKind;
  }
  return "unknown";
}
