import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { getModel, getModels } from "@earendil-works/pi-ai";
import {
  getOAuthProvider,
  type OAuthCredentials,
} from "@earendil-works/pi-ai/oauth";
import {
  getLocalOAuthApiKey,
  getLocalProviderRecordByName,
  type LocalProviderRecord,
  localProviderApiKeyFromRecord,
} from "@/backend/local/local-provider-auth-store";
import {
  type LocalProviderTimeout,
  resolveLocalProviderTimeout,
} from "@/backend/local/local-provider-timeout";
import { isRecord } from "@/utils/type-guards";
import {
  getRegisteredPiProvider,
  type PiProviderModelRegistration,
  type PiProviderRegistration,
  resolveRegisteredPiProviderFromModelHandle,
  stripRegisteredProviderHandlePrefix,
} from "./pi-provider-mod-registry";
import {
  expectedPiProviderList,
  getPiProviderSpec,
  isPiProvider,
  LOCAL_ZAI_CODING_PROVIDER_NAME,
  LOCAL_ZAI_PROVIDER_NAME,
  type PiProvider,
  resolveProviderFromPrefixedModelHandle,
  resolveProviderFromProviderType,
  resolveProviderFromRawLocalModelHandle,
  stripProviderHandlePrefix,
} from "./pi-provider-registry";
import {
  getRegisteredPiProviderLocalNames,
  listRegisteredPiProviderModels,
  resolveRegisteredPiProviderRuntimeConnection,
} from "./registered-pi-provider-runtime";

export const DEFAULT_PI_PROVIDER = "openai" satisfies PiProvider;
export const UNSELECTED_LOCAL_MODEL_HANDLE = "local/default";
export const CUSTOM_OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW = 128000;
export const CUSTOM_OPENAI_COMPATIBLE_DEFAULT_MAX_TOKENS = 32000;
export const CUSTOM_OLLAMA_DEFAULT_CONTEXT_WINDOW = 32768;
export const CUSTOM_OLLAMA_DEFAULT_MAX_TOKENS = 2048;
export type { PiProvider } from "./pi-provider-registry";

export function isUnselectedLocalModelHandle(model: unknown): boolean {
  return (
    typeof model !== "string" ||
    model.length === 0 ||
    model === "auto" ||
    model === UNSELECTED_LOCAL_MODEL_HANDLE ||
    model.startsWith("letta/")
  );
}

function settingString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function thinkingLevelSetting(value: unknown): ThinkingLevel | undefined {
  const effort = settingString(value);
  if (effort === "max") return "xhigh";
  return effort === "minimal" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh"
    ? effort
    : undefined;
}

// Maps Letta model settings to a pi-ai ThinkingLevel. Every pi-ai Anthropic
// call against a reasoning-capable model must pass this when available:
// pi-ai sends `thinking: {type: "disabled"}` for reasoning models when
// `options.reasoning` is absent, and adaptive-thinking models (for example
// claude-fable-5) reject that with a 400 invalid_request_error.
export function reasoningForSettings(
  modelSettings: Record<string, unknown>,
): ThinkingLevel | undefined {
  const thinking = isRecord(modelSettings.thinking)
    ? modelSettings.thinking
    : undefined;
  if (thinking?.type === "disabled") return undefined;
  const nestedReasoning = isRecord(modelSettings.reasoning)
    ? modelSettings.reasoning
    : undefined;
  return (
    thinkingLevelSetting(nestedReasoning?.reasoning_effort) ??
    thinkingLevelSetting(modelSettings.effort) ??
    thinkingLevelSetting(modelSettings.reasoning_effort)
  );
}

export interface PiModelSettings {
  provider_type?: unknown;
  context_window_limit?: unknown;
  max_tokens?: unknown;
  service_tier?: unknown;
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
  if (isPiProvider(provider)) return provider;
  if (getRegisteredPiProvider(provider)) return provider as PiProvider;
  throw new Error(
    `Unknown pi provider "${provider}". Expected ${expectedPiProviderList()}.`,
  );
}

export function resolvePiProviderFromAgent(
  model: string | undefined,
  modelSettings: PiModelSettings = {},
): PiProvider {
  const registeredProvider = resolveRegisteredPiProviderFromModelHandle(
    model,
  ) as PiProvider | undefined;
  if (registeredProvider) return registeredProvider;

  const handleProvider = resolveProviderFromPrefixedModelHandle(model);
  if (handleProvider) return handleProvider;

  const rawLocalProvider = resolveProviderFromRawLocalModelHandle(model);
  const settingsProvider = resolveProviderFromProviderType(
    modelSettings.provider_type,
  );
  if (
    settingsProvider &&
    !(settingsProvider === "openai" && rawLocalProvider)
  ) {
    return settingsProvider;
  }
  if (rawLocalProvider) return rawLocalProvider;

  if (model && !isUnselectedLocalModelHandle(model)) {
    const slashIndex = model.indexOf("/");
    if (slashIndex > 0) {
      throw new Error(
        `Model provider "${model.slice(0, slashIndex)}" is not registered. Load or repair the provider mod, or choose another model with /model.`,
      );
    }
  }

  return resolvePiProvider();
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
  const regularRecord = localProviderRecord(
    ["zai", LOCAL_ZAI_PROVIDER_NAME],
    options.storageDir,
  );
  const codingRecord = localProviderRecord(
    ["zai_coding", LOCAL_ZAI_CODING_PROVIDER_NAME],
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
  oauthCredentials?: OAuthCredentials,
): Model<Api> | undefined {
  const spec = getPiProviderSpec(provider);
  const piProvider = spec.piProvider;
  if (!piProvider) return undefined;
  const catalog = getModels(piProvider);
  const fallbackModelId = fallbackCatalogModelId(piProvider, modelId);
  const model = (catalog.find((model) => model.id === modelId) ??
    catalog.find((model) => model.id === fallbackModelId)) as
    | Model<Api>
    | undefined;
  if (!model || !oauthCredentials) return model;

  const oauthProvider = getOAuthProvider(piProvider);
  return (oauthProvider?.modifyModels?.([model], oauthCredentials)[0] ??
    model) as Model<Api>;
}

function fallbackCatalogModelId(
  provider: string,
  modelId: string,
): string | undefined {
  if (provider !== "openai") return undefined;
  const withoutReleaseDate = modelId.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return withoutReleaseDate === modelId ? undefined : withoutReleaseDate;
}

function customOpenAICompatibleModel(input: {
  provider: PiProvider;
  modelId: string;
  baseURL: string;
  contextWindow?: number;
  maxTokens?: number;
}): Model<"openai-completions"> {
  const defaultContextWindow =
    input.provider === "ollama"
      ? CUSTOM_OLLAMA_DEFAULT_CONTEXT_WINDOW
      : CUSTOM_OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW;
  const defaultMaxTokens =
    input.provider === "ollama"
      ? CUSTOM_OLLAMA_DEFAULT_MAX_TOKENS
      : CUSTOM_OPENAI_COMPATIBLE_DEFAULT_MAX_TOKENS;
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
    contextWindow: input.contextWindow ?? defaultContextWindow,
    maxTokens: input.maxTokens ?? defaultMaxTokens,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
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

function mergeHeaders(
  ...headers: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  for (const header of headers) {
    if (!header) continue;
    Object.assign(merged, header);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function withAuthHeader(
  headers: Record<string, string> | undefined,
  apiKey: string | undefined,
  authHeader: boolean | undefined,
): Record<string, string> | undefined {
  if (!authHeader || !apiKey) return headers;
  return {
    ...headers,
    Authorization: `Bearer ${apiKey}`,
  };
}

function registeredModelToPiModel(input: {
  providerName: string;
  config: PiProviderRegistration;
  model: PiProviderModelRegistration;
  baseURL?: string;
  headers?: Record<string, string>;
}): Model<Api> {
  const api = input.model.api ?? input.config.api;
  if (!api) {
    throw new Error(
      `Provider "${input.providerName}" model "${input.model.id}" is missing an api`,
    );
  }
  return {
    id: input.model.id,
    name: input.model.name,
    api,
    provider: input.providerName,
    baseUrl: input.model.baseUrl ?? input.baseURL ?? "",
    reasoning: input.model.reasoning,
    ...(input.model.thinkingLevelMap
      ? { thinkingLevelMap: input.model.thinkingLevelMap }
      : {}),
    input: input.model.input,
    cost: input.model.cost,
    contextWindow: input.model.contextWindow,
    maxTokens: input.model.maxTokens,
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.model.compat ? { compat: input.model.compat } : {}),
  } as Model<Api>;
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
  const concreteModelHandle = isUnselectedLocalModelHandle(modelHandle)
    ? undefined
    : modelHandle;
  const provider = options.provider
    ? resolvePiProvider(options.provider)
    : resolvePiProviderFromAgent(concreteModelHandle, modelSettings);
  const registeredProvider = getRegisteredPiProvider(provider);
  const spec = isPiProvider(provider) ? getPiProviderSpec(provider) : undefined;
  const modelId =
    options.model ??
    (registeredProvider
      ? stripRegisteredProviderHandlePrefix(concreteModelHandle, provider)
      : undefined) ??
    (spec
      ? resolvePiModelFromAgent(concreteModelHandle, spec.id)
      : undefined) ??
    registeredProvider?.config.models?.[0]?.id ??
    (spec?.defaultModel
      ? resolvePiModelFromAgent(spec.defaultModel, spec.id)
      : undefined) ??
    process.env.LETTA_CODE_DEV_PI_MODEL ??
    "";
  const storageDir = options.localProviderAuthStorageDir;
  const preferredProviderType =
    typeof modelSettings.provider_type === "string"
      ? modelSettings.provider_type
      : options.preferredProviderType;

  let connection = registeredProvider
    ? resolveRegisteredPiProviderRuntimeConnection(
        registeredProvider,
        storageDir,
      )
    : spec
      ? localProviderConnection(
          spec.localProviderNames,
          spec.apiKeyEnv?.() ?? spec.fallbackApiKey,
          storageDir,
        )
      : {
          timeout: resolveLocalProviderTimeout({ providerIds: [provider] }),
        };
  let baseURL =
    connection.baseURL ?? spec?.baseUrlEnv?.() ?? spec?.defaultBaseURL;
  let headers = mergeHeaders(spec?.headers?.(), connection.headers);
  let providerOptions: Record<string, unknown> | undefined;
  let envOverrides: Record<string, string | undefined> | undefined;
  let oauthCredentials: OAuthCredentials | undefined;

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

  if (connection.record?.auth.type === "oauth" && spec?.piProvider) {
    const oauth = await getLocalOAuthApiKey({
      providerId: spec.piProvider,
      providerNames: spec.localProviderNames,
      storageDir,
    });
    connection = {
      ...connection,
      apiKey: oauth?.apiKey,
    };
    oauthCredentials = oauth?.credentials;
  }

  if (
    connection.record?.auth.type === "oauth" &&
    registeredProvider?.config.oauth
  ) {
    const oauth = await getLocalOAuthApiKey({
      providerId: registeredProvider.providerName,
      providerNames: getRegisteredPiProviderLocalNames(registeredProvider),
      storageDir,
    });
    connection = {
      ...connection,
      apiKey: oauth?.apiKey,
    };
    oauthCredentials = oauth?.credentials;
  }

  if (provider === "amazon-bedrock") {
    const bedrock = bedrockLocalProviderOptions(connection.record);
    providerOptions = bedrock.providerOptions;
    envOverrides = bedrock.envOverrides;
  }

  const contextWindow = numericSetting(modelSettings.context_window_limit);
  const maxTokens = numericSetting(modelSettings.max_tokens);
  headers = withAuthHeader(
    headers,
    connection.apiKey,
    registeredProvider?.config.authHeader,
  );

  const registeredModels = registeredProvider
    ? await listRegisteredPiProviderModels(registeredProvider, connection)
    : undefined;
  const registeredModel = registeredModels?.find(
    (model) => model.id === modelId,
  );
  if (registeredModels && !registeredModel) {
    throw new Error(
      `Unknown model "${modelId}" for registered provider "${provider}".`,
    );
  }

  const normalizedBaseURL = spec
    ? (normalizeLocalOpenAICompatibleBaseURL(spec.id, baseURL) ?? baseURL)
    : baseURL;
  let model: Model<Api>;
  if (registeredModel && registeredProvider) {
    const baseModel = registeredModelToPiModel({
      providerName: provider,
      config: registeredProvider.config,
      model: registeredModel,
      baseURL: normalizedBaseURL,
      headers: mergeHeaders(headers, registeredModel.headers),
    });
    const oauthModel =
      oauthCredentials && registeredProvider.config.oauth?.modifyModels
        ? (registeredProvider.config.oauth.modifyModels(
            [baseModel],
            oauthCredentials,
          )[0] ?? baseModel)
        : baseModel;
    model = withOverrides(oauthModel, {
      contextWindow,
      maxTokens,
    });
  } else if (!spec) {
    throw new Error(
      `Unknown model "${modelId}" for provider "${provider}". ` +
        "Register the provider with models before using it.",
    );
  } else if (spec.createCustomModel) {
    if (!modelId) {
      throw new Error(
        `No model selected for provider "${provider}". Choose an available model with /model.`,
      );
    }
    model = customOpenAICompatibleModel({
      provider: spec.id,
      modelId,
      baseURL: normalizedBaseURL ?? spec.defaultBaseURL ?? "",
      contextWindow,
      maxTokens,
    });
  } else {
    const catalogModel = getCatalogModel(spec.id, modelId, oauthCredentials);
    if (catalogModel) {
      model = withOverrides(catalogModel, {
        baseURL,
        headers,
        contextWindow,
        maxTokens,
      });
    } else {
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
      model = withOverrides(fallback, {
        baseURL,
        headers,
        contextWindow,
        maxTokens,
      });
    }
  }

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
