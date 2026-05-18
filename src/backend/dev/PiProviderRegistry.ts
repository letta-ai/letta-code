import type {
  Api,
  KnownProvider,
  Model,
  Provider,
} from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai";

export const LOCAL_CHATGPT_PROVIDER_NAME = "chatgpt-plus-pro";
export const LOCAL_OPENAI_PROVIDER_NAME = "lc-openai";
export const LOCAL_ANTHROPIC_PROVIDER_NAME = "lc-anthropic";
export const LOCAL_DEEPSEEK_PROVIDER_NAME = "lc-deepseek";
export const LOCAL_OPENROUTER_PROVIDER_NAME = "lc-openrouter";
export const LOCAL_OLLAMA_PROVIDER_NAME = "lc-ollama";
export const LOCAL_OLLAMA_CLOUD_PROVIDER_NAME = "lc-ollama-cloud";
export const LOCAL_LMSTUDIO_PROVIDER_NAME = "lc-lmstudio";
export const LOCAL_LLAMA_CPP_PROVIDER_NAME = "lc-llama-cpp";
export const LOCAL_ZAI_PROVIDER_NAME = "lc-zai";
export const LOCAL_ZAI_CODING_PROVIDER_NAME = "lc-zai-coding";
export const LOCAL_MINIMAX_PROVIDER_NAME = "lc-minimax";
export const LOCAL_MOONSHOT_PROVIDER_NAME = "lc-moonshot";
export const LOCAL_KIMI_CODE_PROVIDER_NAME = "lc-kimi-code";
export const LOCAL_GOOGLE_AI_PROVIDER_NAME = "lc-gemini";
export const LOCAL_BEDROCK_PROVIDER_NAME = "lc-bedrock";

const OLLAMA_CLOUD_MODELS = [
  "ollama-cloud/glm-4.7",
  "ollama-cloud/qwen3-coder:480b",
  "ollama-cloud/gpt-oss:20b",
  "ollama-cloud/gpt-oss:120b",
  "ollama-cloud/kimi-k2.5",
  "ollama-cloud/minimax-m2.1",
  "ollama-cloud/deepseek-v3.2",
] as const;

function hasEnvValue(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0;
}

export type PiProvider =
  | "openai-responses"
  | "anthropic"
  | "deepseek"
  | "openrouter"
  | "zai"
  | "minimax"
  | "moonshot"
  | "kimi-coding"
  | "google-ai"
  | "ollama"
  | "ollama-cloud"
  | "lmstudio"
  | "llama-cpp"
  | "bedrock"
  | "chatgpt-oauth";

export interface PiProviderSpec {
  id: PiProvider;
  piProvider?: KnownProvider;
  providerTypes: readonly string[];
  handlePrefixes: readonly string[];
  localProviderNames: readonly string[];
  defaultModel: string;
  defaultBaseURL?: string;
  apiKeyEnv?: () => string | undefined;
  baseUrlEnv?: () => string | undefined;
  fallbackApiKey?: string;
  headers?: () => Record<string, string> | undefined;
  staticModels?: readonly string[];
  localModelDiscovery?: "ollama" | "openai-compatible";
  envConfigured?: () => boolean;
  createCustomModel?: boolean;
  catalogModelHandle?: (model: Model<Api>) => string | undefined;
}

const prefixedCatalogModelHandle = (prefix: string) => (model: Model<Api>) =>
  `${prefix}${model.id}`;

export const PI_PROVIDER_SPECS = [
  {
    id: "openai-responses",
    piProvider: "openai",
    providerTypes: ["openai", "openai-responses"],
    handlePrefixes: ["openai/", "openai-responses/"],
    localProviderNames: [LOCAL_OPENAI_PROVIDER_NAME],
    defaultModel: "openai/gpt-5.5",
    apiKeyEnv: () => process.env.OPENAI_API_KEY,
    envConfigured: () => hasEnvValue(process.env.OPENAI_API_KEY),
    catalogModelHandle: prefixedCatalogModelHandle("openai/"),
  },
  {
    id: "anthropic",
    piProvider: "anthropic",
    providerTypes: ["anthropic"],
    handlePrefixes: ["anthropic/"],
    localProviderNames: [LOCAL_ANTHROPIC_PROVIDER_NAME],
    defaultModel: "anthropic/claude-sonnet-4-6",
    apiKeyEnv: () => process.env.ANTHROPIC_API_KEY,
    envConfigured: () => hasEnvValue(process.env.ANTHROPIC_API_KEY),
    catalogModelHandle: prefixedCatalogModelHandle("anthropic/"),
  },
  {
    id: "deepseek",
    piProvider: "deepseek",
    providerTypes: ["deepseek"],
    handlePrefixes: ["deepseek/"],
    localProviderNames: [LOCAL_DEEPSEEK_PROVIDER_NAME],
    defaultModel: "deepseek/deepseek-chat",
    apiKeyEnv: () => process.env.DEEPSEEK_API_KEY,
    baseUrlEnv: () => process.env.DEEPSEEK_BASE_URL,
    envConfigured: () => hasEnvValue(process.env.DEEPSEEK_API_KEY),
    catalogModelHandle: prefixedCatalogModelHandle("deepseek/"),
  },
  {
    id: "openrouter",
    piProvider: "openrouter",
    providerTypes: ["openrouter"],
    handlePrefixes: ["openrouter/"],
    localProviderNames: [LOCAL_OPENROUTER_PROVIDER_NAME],
    defaultModel: "openrouter/deepseek/deepseek-v4-pro",
    apiKeyEnv: () => process.env.OPENROUTER_API_KEY,
    baseUrlEnv: () => process.env.OPENROUTER_BASE_URL,
    headers: () => ({ "X-Title": "Letta Code" }),
    envConfigured: () => hasEnvValue(process.env.OPENROUTER_API_KEY),
    catalogModelHandle: prefixedCatalogModelHandle("openrouter/"),
  },
  {
    id: "zai",
    piProvider: "zai",
    providerTypes: ["zai", "zai_coding"],
    handlePrefixes: ["zai/"],
    localProviderNames: [
      LOCAL_ZAI_PROVIDER_NAME,
      LOCAL_ZAI_CODING_PROVIDER_NAME,
    ],
    defaultModel: "zai/glm-5.1",
    envConfigured: () =>
      hasEnvValue(process.env.ZAI_API_KEY) ||
      hasEnvValue(process.env.ZHIPU_API_KEY) ||
      hasEnvValue(process.env.ZAI_CODING_API_KEY),
    catalogModelHandle: prefixedCatalogModelHandle("zai/"),
  },
  {
    id: "minimax",
    piProvider: "minimax",
    providerTypes: ["minimax"],
    handlePrefixes: ["minimax/"],
    localProviderNames: [LOCAL_MINIMAX_PROVIDER_NAME],
    defaultModel: "minimax/MiniMax-M2.7",
    apiKeyEnv: () => process.env.MINIMAX_API_KEY,
    baseUrlEnv: () => process.env.MINIMAX_BASE_URL,
    envConfigured: () => hasEnvValue(process.env.MINIMAX_API_KEY),
    catalogModelHandle: prefixedCatalogModelHandle("minimax/"),
  },
  {
    id: "moonshot",
    piProvider: "moonshotai",
    providerTypes: ["moonshot"],
    handlePrefixes: ["moonshot/"],
    localProviderNames: [LOCAL_MOONSHOT_PROVIDER_NAME],
    defaultModel: "moonshot/kimi-k2.5",
    apiKeyEnv: () => process.env.MOONSHOT_API_KEY,
    baseUrlEnv: () => process.env.MOONSHOT_BASE_URL,
    envConfigured: () => hasEnvValue(process.env.MOONSHOT_API_KEY),
    catalogModelHandle: prefixedCatalogModelHandle("moonshot/"),
  },
  {
    id: "kimi-coding",
    piProvider: "kimi-coding",
    providerTypes: ["moonshot_coding"],
    handlePrefixes: ["moonshot_coding/"],
    localProviderNames: [LOCAL_KIMI_CODE_PROVIDER_NAME],
    defaultModel: "moonshot_coding/kimi-for-coding",
    apiKeyEnv: () => process.env.KIMI_API_KEY,
    envConfigured: () => hasEnvValue(process.env.KIMI_API_KEY),
    catalogModelHandle: prefixedCatalogModelHandle("moonshot_coding/"),
  },
  {
    id: "google-ai",
    piProvider: "google",
    providerTypes: ["google_ai"],
    handlePrefixes: ["google_ai/"],
    localProviderNames: [LOCAL_GOOGLE_AI_PROVIDER_NAME],
    defaultModel: "google_ai/gemini-3.1-pro-preview",
    apiKeyEnv: () =>
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY,
    baseUrlEnv: () => process.env.GOOGLE_GENERATIVE_AI_BASE_URL,
    envConfigured: () =>
      hasEnvValue(process.env.GOOGLE_GENERATIVE_AI_API_KEY) ||
      hasEnvValue(process.env.GEMINI_API_KEY),
    catalogModelHandle: prefixedCatalogModelHandle("google_ai/"),
  },
  {
    id: "bedrock",
    piProvider: "amazon-bedrock",
    providerTypes: ["bedrock"],
    handlePrefixes: ["bedrock/"],
    localProviderNames: [LOCAL_BEDROCK_PROVIDER_NAME],
    defaultModel: "bedrock/us.anthropic.claude-sonnet-4-6",
    envConfigured: () =>
      (hasEnvValue(process.env.AWS_ACCESS_KEY_ID) &&
        hasEnvValue(process.env.AWS_SECRET_ACCESS_KEY)) ||
      hasEnvValue(process.env.AWS_PROFILE) ||
      hasEnvValue(process.env.AWS_BEARER_TOKEN_BEDROCK),
    catalogModelHandle: prefixedCatalogModelHandle("bedrock/"),
  },
  {
    id: "ollama",
    providerTypes: ["ollama"],
    handlePrefixes: ["ollama/"],
    localProviderNames: [LOCAL_OLLAMA_PROVIDER_NAME],
    defaultModel: "ollama/llama2",
    defaultBaseURL: "http://localhost:11434/v1",
    apiKeyEnv: () => process.env.OLLAMA_LOCAL_API_KEY,
    baseUrlEnv: () => process.env.OLLAMA_BASE_URL,
    fallbackApiKey: "not-needed",
    localModelDiscovery: "ollama",
    envConfigured: () =>
      hasEnvValue(process.env.OLLAMA_LOCAL_API_KEY) ||
      hasEnvValue(process.env.OLLAMA_BASE_URL),
    createCustomModel: true,
  },
  {
    id: "ollama-cloud",
    providerTypes: ["ollama_cloud"],
    handlePrefixes: ["ollama-cloud/"],
    localProviderNames: [LOCAL_OLLAMA_CLOUD_PROVIDER_NAME],
    defaultModel: "ollama-cloud/gpt-oss:20b",
    staticModels: OLLAMA_CLOUD_MODELS,
    defaultBaseURL: "https://ollama.com/v1",
    apiKeyEnv: () => process.env.OLLAMA_API_KEY,
    baseUrlEnv: () => process.env.OLLAMA_CLOUD_BASE_URL,
    envConfigured: () => hasEnvValue(process.env.OLLAMA_API_KEY),
    createCustomModel: true,
  },
  {
    id: "lmstudio",
    providerTypes: ["lmstudio"],
    handlePrefixes: ["lmstudio/"],
    localProviderNames: [LOCAL_LMSTUDIO_PROVIDER_NAME],
    defaultModel: "lmstudio/google/gemma-3n-e4b",
    defaultBaseURL: "http://127.0.0.1:1234/v1",
    apiKeyEnv: () => process.env.LMSTUDIO_API_KEY,
    baseUrlEnv: () => process.env.LMSTUDIO_BASE_URL,
    fallbackApiKey: "not-needed",
    localModelDiscovery: "openai-compatible",
    envConfigured: () =>
      hasEnvValue(process.env.LMSTUDIO_API_KEY) ||
      hasEnvValue(process.env.LMSTUDIO_BASE_URL),
    createCustomModel: true,
  },
  {
    id: "llama-cpp",
    providerTypes: ["llama_cpp", "llama.cpp"],
    handlePrefixes: ["llama.cpp/", "llama-cpp/"],
    localProviderNames: [LOCAL_LLAMA_CPP_PROVIDER_NAME],
    defaultModel: "llama.cpp/model",
    defaultBaseURL: "http://localhost:8080/v1",
    apiKeyEnv: () => process.env.LLAMA_CPP_API_KEY,
    baseUrlEnv: () =>
      process.env.LLAMA_CPP_BASE_URL ?? process.env.LLAMACPP_BASE_URL,
    fallbackApiKey: "not-needed",
    localModelDiscovery: "openai-compatible",
    envConfigured: () =>
      hasEnvValue(process.env.LLAMA_CPP_API_KEY) ||
      hasEnvValue(process.env.LLAMA_CPP_BASE_URL) ||
      hasEnvValue(process.env.LLAMACPP_BASE_URL),
    createCustomModel: true,
  },
  {
    id: "chatgpt-oauth",
    piProvider: "openai-codex",
    providerTypes: ["chatgpt_oauth"],
    handlePrefixes: ["chatgpt-plus-pro/"],
    localProviderNames: [LOCAL_CHATGPT_PROVIDER_NAME],
    defaultModel: "chatgpt-plus-pro/gpt-5.1-codex-max",
    catalogModelHandle: prefixedCatalogModelHandle("chatgpt-plus-pro/"),
  },
] as const satisfies readonly PiProviderSpec[];

export const SUPPORTED_LOCAL_PROVIDER_TYPES: ReadonlySet<string> = new Set(
  PI_PROVIDER_SPECS.flatMap((provider) => provider.providerTypes),
);

export const KNOWN_PI_PROVIDERS = new Set(
  PI_PROVIDER_SPECS.map((provider) => provider.id),
);

export const PROVIDER_TYPE_TO_BASE_PROVIDER = Object.fromEntries(
  PI_PROVIDER_SPECS.flatMap((provider) =>
    provider.providerTypes.map((providerType) => [
      providerType,
      provider.handlePrefixes[0]?.slice(0, -1) ?? provider.id,
    ]),
  ),
) as Record<string, string>;

export function getPiProviderSpec(provider: PiProvider): PiProviderSpec {
  const spec = PI_PROVIDER_SPECS.find((entry) => entry.id === provider);
  if (!spec) {
    throw new Error(`Unknown pi provider "${provider}".`);
  }
  return spec;
}

export function isPiProvider(provider: string): provider is PiProvider {
  return KNOWN_PI_PROVIDERS.has(provider as PiProvider);
}

export function expectedPiProviderList(): string {
  return PI_PROVIDER_SPECS.map((provider) => `"${provider.id}"`).join(", ");
}

export function resolveProviderFromModelHandle(
  model: string | undefined,
): PiProvider | undefined {
  if (!model) return undefined;
  return PI_PROVIDER_SPECS.find((provider) =>
    provider.handlePrefixes.some((prefix) => model.startsWith(prefix)),
  )?.id;
}

export function resolveProviderFromProviderType(
  providerType: unknown,
): PiProvider | undefined {
  if (typeof providerType !== "string") return undefined;
  return PI_PROVIDER_SPECS.find((provider) =>
    (provider.providerTypes as readonly string[]).includes(providerType),
  )?.id;
}

export function stripProviderHandlePrefix(
  model: string | undefined,
  provider: PiProvider,
): string | undefined {
  if (!model) return process.env.LETTA_CODE_DEV_PI_MODEL;
  const spec = getPiProviderSpec(provider);
  const prefix = spec.handlePrefixes.find((prefix) => model.startsWith(prefix));
  return prefix ? model.slice(prefix.length) : model;
}

export function hasKnownProviderHandlePrefix(model: string): boolean {
  return PI_PROVIDER_SPECS.some((provider) =>
    provider.handlePrefixes.some((prefix) => model.startsWith(prefix)),
  );
}

export function localProviderType(provider: PiProvider): string {
  return getPiProviderSpec(provider).providerTypes[0] ?? "openai";
}

export function localModelHandle(provider: PiProvider, model: string): string {
  const spec = getPiProviderSpec(provider);
  if (spec.handlePrefixes.some((prefix) => model.startsWith(prefix))) {
    return model;
  }
  const prefix = spec.handlePrefixes[0];
  return prefix ? `${prefix}${model}` : model;
}

export function resolveLocalModel(provider: PiProvider): string {
  return getPiProviderSpec(provider).defaultModel;
}

function isProviderConfigured(
  provider: PiProviderSpec,
  localProviderNames: ReadonlySet<string>,
): boolean {
  return (
    provider.localProviderNames.some((name) => localProviderNames.has(name)) ||
    provider.envConfigured?.() === true
  );
}

export function listConfiguredPiProviders(
  localProviderNames: ReadonlySet<string>,
): PiProvider[] {
  return PI_PROVIDER_SPECS.filter((provider) =>
    isProviderConfigured(provider, localProviderNames),
  ).map((provider) => provider.id);
}

export function listCatalogModelsForProvider(provider: PiProvider): string[] {
  const spec = getPiProviderSpec(provider);
  const seen = new Set<string>();
  const models: string[] = [];
  const add = (model: string | undefined) => {
    if (!model || seen.has(model)) return;
    seen.add(model);
    models.push(model);
  };

  add(spec.defaultModel);
  if (spec.piProvider && spec.catalogModelHandle) {
    for (const model of getModels(spec.piProvider)) {
      add(spec.catalogModelHandle(model as Model<Api>));
    }
  }
  for (const model of spec.staticModels ?? []) {
    add(model);
  }

  return models;
}

export function piProviderFromModel(
  modelHandle: string,
  modelSettings: Record<string, unknown>,
): PiProvider | undefined {
  return (
    resolveProviderFromModelHandle(modelHandle) ??
    resolveProviderFromProviderType(modelSettings.provider_type)
  );
}

export function piProviderNameForModel(
  modelHandle: string,
  modelSettings: Record<string, unknown>,
): Provider | undefined {
  const provider = piProviderFromModel(modelHandle, modelSettings);
  const spec = provider ? getPiProviderSpec(provider) : undefined;
  return spec?.piProvider;
}
