import type { Api, KnownProvider, Model } from "@earendil-works/pi-ai";
import {
  getEnvApiKey,
  getModels,
  getProviders,
} from "@earendil-works/pi-ai/compat";

export const LOCAL_CHATGPT_PROVIDER_NAME = "chatgpt-plus-pro";
export const LOCAL_OPENAI_PROVIDER_NAME = "lc-openai";
export const LOCAL_ANTHROPIC_PROVIDER_NAME = "lc-anthropic";
export const LOCAL_OPENROUTER_PROVIDER_NAME = "lc-openrouter";
export const LOCAL_OLLAMA_PROVIDER_NAME = "lc-ollama";
export const LOCAL_OLLAMA_CLOUD_PROVIDER_NAME = "lc-ollama-cloud";
export const LOCAL_LMSTUDIO_PROVIDER_NAME = "lc-lmstudio";
export const LMSTUDIO_OPENAI_PROVIDER_TYPE = "lmstudio_openai";
export const LEGACY_LMSTUDIO_PROVIDER_TYPE = "lmstudio";
export const LOCAL_LLAMA_CPP_PROVIDER_NAME = "lc-llama-cpp";
export const LOCAL_ZAI_PROVIDER_NAME = "lc-zai";
export const LOCAL_ZAI_CODING_PROVIDER_NAME = "lc-zai-coding";
export const LOCAL_MINIMAX_PROVIDER_NAME = "lc-minimax";
export const LOCAL_MOONSHOT_PROVIDER_NAME = "lc-moonshot";
export const LOCAL_KIMI_CODE_PROVIDER_NAME = "lc-kimi-code";
export const LOCAL_GOOGLE_AI_PROVIDER_NAME = "lc-gemini";
export const LOCAL_BEDROCK_PROVIDER_NAME = "lc-bedrock";

export type LocalEndpointProvider =
  | "ollama"
  | "ollama-cloud"
  | "lmstudio"
  | "llama-cpp";

export type PiProvider = KnownProvider | LocalEndpointProvider;

export interface PiProviderSpec {
  id: PiProvider;
  piProvider?: KnownProvider;
  providerTypes: readonly string[];
  handlePrefixes: readonly string[];
  localProviderNames: readonly string[];
  defaultModel?: string;
  defaultBaseURL?: string;
  apiKeyEnv?: () => string | undefined;
  baseUrlEnv?: () => string | undefined;
  fallbackApiKey?: string;
  headers?: () => Record<string, string> | undefined;
  localModelDiscovery?: "ollama" | "openai-compatible";
  autoDetectLocalEndpoint?: boolean;
  envConfigured?: () => boolean;
  createCustomModel?: boolean;
  catalogModelHandle?: (model: Model<Api>) => string | undefined;
}

interface PiProviderOverride {
  providerTypes?: readonly string[];
  handlePrefixes?: readonly string[];
  localProviderNames?: readonly string[];
  defaultBaseURL?: string;
  apiKeyEnv?: () => string | undefined;
  baseUrlEnv?: () => string | undefined;
  fallbackApiKey?: string;
  headers?: () => Record<string, string> | undefined;
  localModelDiscovery?: "ollama" | "openai-compatible";
  autoDetectLocalEndpoint?: boolean;
  envConfigured?: () => boolean;
  createCustomModel?: boolean;
  catalogModelHandle?: (model: Model<Api>) => string | undefined;
}

function hasEnvValue(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

const prefixedCatalogModelHandle = (prefix: string) => (model: Model<Api>) =>
  `${prefix}${model.id}`;

const PI_PROVIDER_ALIASES: Record<string, PiProvider> = {
  "openai-responses": "openai",
  "google-ai": "google",
  bedrock: "amazon-bedrock",
  "chatgpt-oauth": "openai-codex",
  moonshot: "moonshotai",
  "kimi-code": "kimi-coding",
};

// Keep LC's built-in provider defaults aligned with Pi TUI's
// `defaultModelPerProvider` until Pi exposes this through a narrow runtime
// package/API. Local endpoint providers intentionally have no default here;
// they must resolve to explicit or discovered local models.
export const PI_TUI_DEFAULT_MODEL_IDS: Partial<Record<KnownProvider, string>> =
  {
    "amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
    anthropic: "claude-opus-4-7",
    openai: "gpt-5.4",
    "azure-openai-responses": "gpt-5.4",
    "openai-codex": "gpt-5.5",
    deepseek: "deepseek-v4-pro",
    google: "gemini-3.1-pro-preview",
    "google-vertex": "gemini-3.1-pro-preview",
    "github-copilot": "gpt-5.4",
    openrouter: "moonshotai/kimi-k2.6",
    "vercel-ai-gateway": "zai/glm-5.1",
    xai: "grok-4.20-0309-reasoning",
    groq: "openai/gpt-oss-120b",
    cerebras: "zai-glm-4.7",
    zai: "glm-5.2",
    mistral: "devstral-medium-latest",
    minimax: "MiniMax-M2.7",
    "minimax-cn": "MiniMax-M2.7",
    moonshotai: "kimi-k2.6",
    "moonshotai-cn": "kimi-k2.6",
    huggingface: "moonshotai/Kimi-K2.6",
    fireworks: "accounts/fireworks/models/kimi-k2p6",
    together: "moonshotai/Kimi-K2.6",
    opencode: "kimi-k2.6",
    "opencode-go": "kimi-k2.6",
    "kimi-coding": "kimi-for-coding",
    "cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
    "cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
    xiaomi: "mimo-v2.5-pro",
    "xiaomi-token-plan-cn": "mimo-v2.5-pro",
    "xiaomi-token-plan-ams": "mimo-v2.5-pro",
    "xiaomi-token-plan-sgp": "mimo-v2.5-pro",
  };

// These pi-ai providers are intentionally absent from Pi TUI's
// `defaultModelPerProvider`. Keep the omission explicit so newly added pi-ai
// providers cannot silently inherit catalog-order defaults without review.
export const PI_TUI_DEFAULTLESS_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "ant-ling",
  "nvidia",
  "zai-coding-cn",
]);

const PI_PROVIDER_OVERRIDES: Partial<
  Record<KnownProvider, PiProviderOverride>
> = {
  openai: {
    providerTypes: ["openai", "openai-responses"],
    handlePrefixes: ["openai/", "openai-responses/"],
    localProviderNames: ["openai", LOCAL_OPENAI_PROVIDER_NAME],
  },
  anthropic: {
    localProviderNames: ["anthropic", LOCAL_ANTHROPIC_PROVIDER_NAME],
  },
  openrouter: {
    localProviderNames: ["openrouter", LOCAL_OPENROUTER_PROVIDER_NAME],
    baseUrlEnv: () => process.env.OPENROUTER_BASE_URL,
    headers: () => ({
      "HTTP-Referer": "https://letta.com",
      "X-OpenRouter-Title": "Letta Code",
      "X-OpenRouter-Categories": "cli-agent,personal-agent",
    }),
  },
  zai: {
    providerTypes: ["zai", "zai_coding"],
    localProviderNames: [
      "zai",
      "zai_coding",
      LOCAL_ZAI_PROVIDER_NAME,
      LOCAL_ZAI_CODING_PROVIDER_NAME,
    ],
    envConfigured: () =>
      getEnvApiKey("zai") !== undefined ||
      hasEnvValue(process.env.ZHIPU_API_KEY) ||
      hasEnvValue(process.env.ZAI_CODING_API_KEY),
  },
  minimax: {
    localProviderNames: ["minimax", LOCAL_MINIMAX_PROVIDER_NAME],
    baseUrlEnv: () => process.env.MINIMAX_BASE_URL,
  },
  moonshotai: {
    providerTypes: ["moonshotai", "moonshot"],
    handlePrefixes: ["moonshotai/", "moonshot/"],
    localProviderNames: ["moonshotai", LOCAL_MOONSHOT_PROVIDER_NAME],
    baseUrlEnv: () => process.env.MOONSHOT_BASE_URL,
  },
  "kimi-coding": {
    providerTypes: ["kimi-coding", "moonshot_coding"],
    handlePrefixes: ["kimi-coding/", "moonshot_coding/"],
    localProviderNames: ["kimi-coding", LOCAL_KIMI_CODE_PROVIDER_NAME],
  },
  google: {
    providerTypes: ["google", "google_ai"],
    handlePrefixes: ["google/", "google_ai/"],
    localProviderNames: ["google", LOCAL_GOOGLE_AI_PROVIDER_NAME],
    apiKeyEnv: () =>
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? getEnvApiKey("google"),
    baseUrlEnv: () => process.env.GOOGLE_GENERATIVE_AI_BASE_URL,
    envConfigured: () =>
      hasEnvValue(process.env.GOOGLE_GENERATIVE_AI_API_KEY) ||
      getEnvApiKey("google") !== undefined,
  },
  "amazon-bedrock": {
    providerTypes: ["amazon-bedrock", "bedrock"],
    handlePrefixes: ["amazon-bedrock/", "bedrock/"],
    localProviderNames: ["amazon-bedrock", LOCAL_BEDROCK_PROVIDER_NAME],
  },
  "openai-codex": {
    providerTypes: ["chatgpt_oauth", "openai-codex"],
    handlePrefixes: ["openai-codex/", "chatgpt-plus-pro/"],
    localProviderNames: ["openai-codex", LOCAL_CHATGPT_PROVIDER_NAME],
  },
};

function defaultModelForProvider(
  provider: KnownProvider,
  handlePrefix: string,
): string {
  const piTuiDefault = PI_TUI_DEFAULT_MODEL_IDS[provider];
  if (piTuiDefault) return `${handlePrefix}${piTuiDefault}`;
  // Match Pi TUI's no-explicit-default behavior for providers omitted from its
  // default map: use catalog order as the generic fallback.
  const model = getModels(provider)[0] as Model<Api> | undefined;
  return model ? `${handlePrefix}${model.id}` : `${handlePrefix}model`;
}

function makePiProviderSpec(provider: KnownProvider): PiProviderSpec {
  const override = PI_PROVIDER_OVERRIDES[provider] ?? {};
  const handlePrefixes = unique(override.handlePrefixes ?? [`${provider}/`]);
  const providerTypes = unique(override.providerTypes ?? [provider]);
  const localProviderNames = unique(override.localProviderNames ?? [provider]);
  const primaryHandlePrefix = handlePrefixes[0] ?? `${provider}/`;
  return {
    id: provider,
    piProvider: provider,
    providerTypes,
    handlePrefixes,
    localProviderNames,
    defaultModel: defaultModelForProvider(provider, primaryHandlePrefix),
    ...(override.defaultBaseURL
      ? { defaultBaseURL: override.defaultBaseURL }
      : {}),
    apiKeyEnv: override.apiKeyEnv ?? (() => getEnvApiKey(provider)),
    ...(override.baseUrlEnv ? { baseUrlEnv: override.baseUrlEnv } : {}),
    ...(override.fallbackApiKey
      ? { fallbackApiKey: override.fallbackApiKey }
      : {}),
    ...(override.headers ? { headers: override.headers } : {}),
    ...(override.localModelDiscovery
      ? { localModelDiscovery: override.localModelDiscovery }
      : {}),
    ...(override.autoDetectLocalEndpoint !== undefined
      ? { autoDetectLocalEndpoint: override.autoDetectLocalEndpoint }
      : {}),
    envConfigured:
      override.envConfigured ?? (() => getEnvApiKey(provider) !== undefined),
    ...(override.createCustomModel !== undefined
      ? { createCustomModel: override.createCustomModel }
      : {}),
    catalogModelHandle:
      override.catalogModelHandle ??
      prefixedCatalogModelHandle(primaryHandlePrefix),
  };
}

const LOCAL_ENDPOINT_PROVIDER_SPECS: readonly PiProviderSpec[] = [
  {
    id: "ollama",
    providerTypes: ["ollama"],
    handlePrefixes: ["ollama/"],
    localProviderNames: ["ollama", LOCAL_OLLAMA_PROVIDER_NAME],
    defaultBaseURL: "http://localhost:11434/v1",
    apiKeyEnv: () => process.env.OLLAMA_LOCAL_API_KEY,
    baseUrlEnv: () => process.env.OLLAMA_BASE_URL,
    fallbackApiKey: "not-needed",
    localModelDiscovery: "ollama",
    autoDetectLocalEndpoint: true,
    envConfigured: () =>
      hasEnvValue(process.env.OLLAMA_LOCAL_API_KEY) ||
      hasEnvValue(process.env.OLLAMA_BASE_URL),
    createCustomModel: true,
  },
  {
    id: "ollama-cloud",
    providerTypes: ["ollama_cloud"],
    handlePrefixes: ["ollama-cloud/"],
    localProviderNames: ["ollama-cloud", LOCAL_OLLAMA_CLOUD_PROVIDER_NAME],
    defaultBaseURL: "https://ollama.com/v1",
    apiKeyEnv: () => process.env.OLLAMA_API_KEY,
    baseUrlEnv: () => process.env.OLLAMA_CLOUD_BASE_URL,
    localModelDiscovery: "openai-compatible",
    envConfigured: () => hasEnvValue(process.env.OLLAMA_API_KEY),
    createCustomModel: true,
  },
  {
    id: "lmstudio",
    providerTypes: [
      LMSTUDIO_OPENAI_PROVIDER_TYPE,
      LEGACY_LMSTUDIO_PROVIDER_TYPE,
    ],
    handlePrefixes: ["lmstudio/"],
    localProviderNames: ["lmstudio", LOCAL_LMSTUDIO_PROVIDER_NAME],
    defaultBaseURL: "http://127.0.0.1:1234/v1",
    apiKeyEnv: () => process.env.LMSTUDIO_API_KEY,
    baseUrlEnv: () => process.env.LMSTUDIO_BASE_URL,
    fallbackApiKey: "not-needed",
    localModelDiscovery: "openai-compatible",
    autoDetectLocalEndpoint: true,
    envConfigured: () =>
      hasEnvValue(process.env.LMSTUDIO_API_KEY) ||
      hasEnvValue(process.env.LMSTUDIO_BASE_URL),
    createCustomModel: true,
  },
  {
    id: "llama-cpp",
    providerTypes: ["llama_cpp", "llama.cpp"],
    handlePrefixes: ["llama.cpp/", "llama-cpp/"],
    localProviderNames: ["llama-cpp", LOCAL_LLAMA_CPP_PROVIDER_NAME],
    defaultBaseURL: "http://localhost:8080/v1",
    apiKeyEnv: () => process.env.LLAMA_CPP_API_KEY,
    baseUrlEnv: () =>
      process.env.LLAMA_CPP_BASE_URL ?? process.env.LLAMACPP_BASE_URL,
    fallbackApiKey: "not-needed",
    localModelDiscovery: "openai-compatible",
    autoDetectLocalEndpoint: true,
    envConfigured: () =>
      hasEnvValue(process.env.LLAMA_CPP_API_KEY) ||
      hasEnvValue(process.env.LLAMA_CPP_BASE_URL) ||
      hasEnvValue(process.env.LLAMACPP_BASE_URL),
    createCustomModel: true,
  },
];

export const PI_PROVIDER_SPECS: readonly PiProviderSpec[] = [
  ...getProviders().map(makePiProviderSpec),
  ...LOCAL_ENDPOINT_PROVIDER_SPECS,
];

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

function canonicalProvider(provider: string): PiProvider | undefined {
  if (KNOWN_PI_PROVIDERS.has(provider as PiProvider)) {
    return provider as PiProvider;
  }
  return PI_PROVIDER_ALIASES[provider];
}

export function getPiProviderSpec(provider: PiProvider): PiProviderSpec {
  const canonical = canonicalProvider(provider) ?? provider;
  const spec = PI_PROVIDER_SPECS.find((entry) => entry.id === canonical);
  if (!spec) {
    throw new Error(`Unknown pi provider "${provider}".`);
  }
  return spec;
}

export function isPiProvider(provider: string): provider is PiProvider {
  return canonicalProvider(provider) !== undefined;
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
    provider.providerTypes.includes(providerType),
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

export function localProviderType(provider: PiProvider): string {
  return getPiProviderSpec(provider).providerTypes[0] ?? provider;
}

export function localModelHandle(provider: PiProvider, model: string): string {
  const spec = getPiProviderSpec(provider);
  if (spec.handlePrefixes.some((prefix) => model.startsWith(prefix))) {
    return model;
  }
  const prefix = spec.handlePrefixes[0];
  return prefix ? `${prefix}${model}` : model;
}

export function resolveLocalModel(provider: PiProvider): string | undefined {
  return getPiProviderSpec(provider).defaultModel;
}

function isProviderConfigured(
  provider: PiProviderSpec,
  localProviderIdentifiers: ReadonlySet<string>,
): boolean {
  return (
    provider.localProviderNames.some((name) =>
      localProviderIdentifiers.has(name),
    ) ||
    provider.providerTypes.some((providerType) =>
      localProviderIdentifiers.has(providerType),
    ) ||
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
