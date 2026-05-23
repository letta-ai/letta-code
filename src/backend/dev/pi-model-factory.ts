import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel, getModels } from "@earendil-works/pi-ai";
import {
  getLocalChatGPTApiKey,
  getLocalProviderRecordByName,
  type LocalProviderRecord,
  localProviderApiKeyFromRecord,
} from "@/backend/local/local-provider-auth-store";
import {
  type LocalProviderTimeout,
  resolveLocalProviderTimeout,
} from "@/backend/local/local-provider-timeout";
import {
  expectedPiProviderList,
  getPiProviderSpec,
  isPiProvider,
  LOCAL_ZAI_CODING_PROVIDER_NAME,
  LOCAL_ZAI_PROVIDER_NAME,
  type PiProvider,
  resolveProviderFromModelHandle,
  resolveProviderFromProviderType,
  stripProviderHandlePrefix,
} from "./pi-provider-registry";

export const DEFAULT_PI_PROVIDER = "openai-responses" satisfies PiProvider;
export type { PiProvider } from "./pi-provider-registry";

export interface PiModelSettings {
  provider_type?: unknown;
  context_window_limit?: unknown;
  max_tokens?: unknown;
}

export interface PiModelFactoryOptions {
  provider?: string;
  model?: string;
  localProviderAuthStorageDir?: string;
  preferredProviderType?: string;
}

export interface ResolvedPiModel {
  provider: PiProvider;
  model: Model<Api>;
  apiKey?: string;
  timeout: LocalProviderTimeout;
  headers?: Record<string, string>;
  providerOptions?: Record<string, unknown>;
  envOverrides?: Record<string, string | undefined>;
}

export function applyPiEnvOverrides(
  overrides: Record<string, string | undefined> | undefined,
): () => void {
  if (!overrides) return () => {};
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function hasEnvValue(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0;
}

function inferDefaultProviderFromStandardKeys(): PiProvider {
  const hasOpenAIKey = hasEnvValue(process.env.OPENAI_API_KEY);
  const hasAnthropicKey = hasEnvValue(process.env.ANTHROPIC_API_KEY);

  if (!hasOpenAIKey && hasAnthropicKey) return "anthropic";
  return DEFAULT_PI_PROVIDER;
}

export function resolvePiProvider(
  provider = process.env.LETTA_CODE_DEV_PI_PROVIDER ??
    inferDefaultProviderFromStandardKeys(),
): PiProvider {
  if (provider === "openai") return "openai-responses";
  if (isPiProvider(provider)) return provider;
  throw new Error(
    `Unknown pi provider "${provider}". Expected ${expectedPiProviderList()}.`,
  );
}

export function resolvePiProviderFromAgent(
  model: string | undefined,
  modelSettings: PiModelSettings = {},
): PiProvider {
  return (
    resolveProviderFromModelHandle(model) ??
    resolveProviderFromProviderType(modelSettings.provider_type) ??
    resolvePiProvider()
  );
}

export function resolvePiModelFromAgent(
  model: string | undefined,
  provider: PiProvider,
): string | undefined {
  return stripProviderHandlePrefix(model, provider);
}

function localProviderRecord(
  providerNames: readonly string[],
  storageDir?: string,
): LocalProviderRecord | null {
  for (const providerName of providerNames) {
    const record = getLocalProviderRecordByName(providerName, storageDir);
    if (record) return record;
  }
  return null;
}

function localProviderConnection(
  providerNames: readonly string[],
  envValue: string | undefined,
  storageDir?: string,
): {
  apiKey?: string;
  baseURL?: string;
  timeout: LocalProviderTimeout;
  headers?: Record<string, string>;
  record?: LocalProviderRecord;
} {
  const record = localProviderRecord(providerNames, storageDir);
  return {
    apiKey: localProviderApiKeyFromRecord(record) ?? envValue,
    baseURL: record?.base_url,
    timeout: resolveLocalProviderTimeout({
      configuredTimeout: record?.timeout,
      providerIds: providerNames,
    }),
    ...(record ? { record } : {}),
  };
}

export interface ZaiConnection {
  apiKey?: string;
  baseURL: string;
  providerName: "zai" | "zai-coding";
  timeout: LocalProviderTimeout;
}

export function resolveZaiConnection(options: {
  storageDir?: string;
  preferredProviderType?: "zai" | "zai_coding";
}): ZaiConnection {
  const regularRecord = getLocalProviderRecordByName(
    LOCAL_ZAI_PROVIDER_NAME,
    options.storageDir,
  );
  const codingRecord = getLocalProviderRecordByName(
    LOCAL_ZAI_CODING_PROVIDER_NAME,
    options.storageDir,
  );
  const regularKey =
    localProviderApiKeyFromRecord(regularRecord) ??
    process.env.ZAI_API_KEY ??
    process.env.ZHIPU_API_KEY;
  const codingKey =
    localProviderApiKeyFromRecord(codingRecord) ??
    process.env.ZAI_CODING_API_KEY;
  const regularConnection: ZaiConnection = {
    providerName: "zai",
    baseURL:
      regularRecord?.base_url ??
      process.env.ZAI_BASE_URL ??
      "https://api.z.ai/api/paas/v4",
    apiKey: regularKey,
    timeout: resolveLocalProviderTimeout({
      configuredTimeout: regularRecord?.timeout,
      providerIds: [LOCAL_ZAI_PROVIDER_NAME, "zai"],
    }),
  };
  const codingConnection: ZaiConnection = {
    providerName: "zai-coding",
    baseURL:
      codingRecord?.base_url ??
      process.env.ZAI_CODING_BASE_URL ??
      "https://api.z.ai/api/coding/paas/v4",
    apiKey: codingKey,
    timeout: resolveLocalProviderTimeout({
      configuredTimeout: codingRecord?.timeout,
      providerIds: [LOCAL_ZAI_CODING_PROVIDER_NAME, "zai-coding"],
    }),
  };

  if (options.preferredProviderType === "zai_coding" && codingKey) {
    return codingConnection;
  }
  if (options.preferredProviderType === "zai" && regularKey) {
    return regularConnection;
  }
  if (codingKey) return codingConnection;
  if (regularKey) return regularConnection;
  return codingConnection;
}

function getCatalogModel(
  provider: PiProvider,
  modelId: string,
): Model<Api> | undefined {
  const spec = getPiProviderSpec(provider);
  if (!spec.piProvider) return undefined;
  return getModels(spec.piProvider).find((model) => model.id === modelId) as
    | Model<Api>
    | undefined;
}

function customOpenAICompatibleModel(input: {
  provider: PiProvider;
  modelId: string;
  baseURL: string;
  contextWindow?: number;
  maxTokens?: number;
}): Model<"openai-completions"> {
  return {
    id: input.modelId,
    name: input.modelId,
    api: "openai-completions",
    provider: input.provider,
    baseUrl: input.baseURL,
    reasoning:
      input.modelId.includes("gpt-oss") ||
      input.modelId.includes("qwen3") ||
      input.modelId.includes("deepseek-r1"),
    input:
      input.modelId.includes("llava") ||
      input.modelId.includes("vision") ||
      input.modelId.includes("vl")
        ? ["text", "image"]
        : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: input.contextWindow ?? 128000,
    maxTokens: input.maxTokens ?? 32000,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
}

function withOverrides(
  model: Model<Api>,
  overrides: {
    baseURL?: string;
    headers?: Record<string, string>;
    contextWindow?: number;
    maxTokens?: number;
  },
): Model<Api> {
  return {
    ...model,
    ...(overrides.baseURL ? { baseUrl: overrides.baseURL } : {}),
    ...(overrides.headers
      ? { headers: { ...model.headers, ...overrides.headers } }
      : {}),
    ...(overrides.contextWindow
      ? { contextWindow: overrides.contextWindow }
      : {}),
    ...(overrides.maxTokens ? { maxTokens: overrides.maxTokens } : {}),
  };
}

function numericSetting(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeLocalOpenAICompatibleBaseURL(
  provider: PiProvider,
  baseURL: string | undefined,
): string | undefined {
  if (!baseURL) return undefined;
  if (!getPiProviderSpec(provider).localModelDiscovery) return baseURL;

  const trimmed = baseURL.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function bedrockLocalProviderOptions(record: LocalProviderRecord | undefined): {
  providerOptions?: Record<string, unknown>;
  envOverrides?: Record<string, string | undefined>;
} {
  if (!record) return {};

  const providerOptions: Record<string, unknown> = {};
  const envOverrides: Record<string, string | undefined> = {};
  if (record.region) {
    providerOptions.region = record.region;
    envOverrides.AWS_REGION = record.region;
    envOverrides.AWS_DEFAULT_REGION = record.region;
  }
  if (record.profile) {
    providerOptions.profile = record.profile;
    envOverrides.AWS_PROFILE = record.profile;
  }
  if (record.auth.type === "api" && record.auth.key) {
    if (record.access_key) {
      envOverrides.AWS_ACCESS_KEY_ID = record.access_key;
      envOverrides.AWS_SECRET_ACCESS_KEY = record.auth.key;
    } else {
      providerOptions.bearerToken = record.auth.key;
      envOverrides.AWS_BEARER_TOKEN_BEDROCK = record.auth.key;
    }
  }

  return {
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
  };
}

export async function resolvePiModelForAgent(
  modelHandle: string | undefined,
  modelSettings: PiModelSettings = {},
  options: PiModelFactoryOptions = {},
): Promise<ResolvedPiModel> {
  const provider = options.provider
    ? resolvePiProvider(options.provider)
    : resolvePiProviderFromAgent(modelHandle, modelSettings);
  const spec = getPiProviderSpec(provider);
  const modelId =
    options.model ??
    resolvePiModelFromAgent(modelHandle, provider) ??
    resolvePiModelFromAgent(spec.defaultModel, provider) ??
    process.env.LETTA_CODE_DEV_PI_MODEL ??
    "";
  const storageDir = options.localProviderAuthStorageDir;
  const preferredProviderType =
    typeof modelSettings.provider_type === "string"
      ? modelSettings.provider_type
      : options.preferredProviderType;

  let connection = localProviderConnection(
    spec.localProviderNames,
    spec.apiKeyEnv?.() ?? spec.fallbackApiKey,
    storageDir,
  );
  let baseURL =
    connection.baseURL ?? spec.baseUrlEnv?.() ?? spec.defaultBaseURL;
  const headers = spec.headers?.();
  let providerOptions: Record<string, unknown> | undefined;
  let envOverrides: Record<string, string | undefined> | undefined;

  if (provider === "zai") {
    const zai = resolveZaiConnection({
      storageDir,
      preferredProviderType:
        preferredProviderType === "zai" ||
        preferredProviderType === "zai_coding"
          ? preferredProviderType
          : undefined,
    });
    connection = {
      apiKey: zai.apiKey,
      baseURL: zai.baseURL,
      timeout: zai.timeout,
    };
    baseURL = zai.baseURL;
  }

  if (provider === "chatgpt-oauth") {
    connection = {
      ...connection,
      apiKey: await getLocalChatGPTApiKey(storageDir),
    };
  }

  if (provider === "bedrock") {
    const bedrock = bedrockLocalProviderOptions(connection.record);
    providerOptions = bedrock.providerOptions;
    envOverrides = bedrock.envOverrides;
  }

  const contextWindow = numericSetting(modelSettings.context_window_limit);
  const maxTokens = numericSetting(modelSettings.max_tokens);
  const catalogModel = getCatalogModel(provider, modelId);
  const model = spec.createCustomModel
    ? customOpenAICompatibleModel({
        provider,
        modelId,
        baseURL:
          normalizeLocalOpenAICompatibleBaseURL(provider, baseURL) ??
          spec.defaultBaseURL ??
          "",
        contextWindow,
        maxTokens,
      })
    : catalogModel
      ? withOverrides(catalogModel, {
          baseURL,
          headers,
          contextWindow,
          maxTokens,
        })
      : (() => {
          const fallback = getModel(
            spec.piProvider ?? "openai",
            modelId as never,
          ) as Model<Api> | undefined;
          if (!fallback) {
            throw new Error(
              `Unknown model "${modelId}" for provider "${provider}". ` +
                "Check the model handle or update the model catalog.",
            );
          }
          return withOverrides(fallback, {
            baseURL,
            headers,
            contextWindow,
            maxTokens,
          });
        })();

  return {
    provider,
    model,
    apiKey: connection.apiKey,
    timeout: connection.timeout,
    headers,
    providerOptions,
    envOverrides,
  };
}
