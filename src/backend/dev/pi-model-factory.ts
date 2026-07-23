import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import {
  getLocalProviderRecordByName,
  type LocalProviderRecord,
  localProviderApiKeyFromRecord,
} from "@/backend/local/local-provider-auth-store";
import {
  type LocalProviderTimeout,
  resolveLocalProviderTimeout,
} from "@/backend/local/local-provider-timeout";
import { isRecord } from "@/utils/type-guards";
import { LocalPiModelsRuntime } from "./pi-models-runtime";
import {
  getRegisteredPiProvider,
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
  resolveProviderFromModelHandle,
  resolveProviderFromProviderType,
  stripProviderHandlePrefix,
} from "./pi-provider-registry";
import { resolveRegisteredPiProviderRuntimeConnection } from "./registered-pi-provider-runtime";

export const DEFAULT_PI_PROVIDER = "openai" satisfies PiProvider;
export const UNSELECTED_LOCAL_MODEL_HANDLE = "local/default";
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

function normalizeOpenAICompatibleLocalModelHandle(
  model: string | undefined,
): string | undefined {
  if (!model?.startsWith("openai/")) return model;
  const nestedHandle = model.slice("openai/".length);
  const nestedProvider = resolveProviderFromModelHandle(nestedHandle);
  if (!nestedProvider) return model;
  return getPiProviderSpec(nestedProvider).localModelDiscovery ===
    "openai-compatible"
    ? nestedHandle
    : model;
}

function settingString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function thinkingLevelSetting(
  value: unknown,
  preserveMax: boolean,
): ThinkingLevel | undefined {
  const effort = settingString(value);
  if (effort === "max") return preserveMax ? "max" : "xhigh";
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
  modelHandle?: string,
): ThinkingLevel | undefined {
  const thinking = isRecord(modelSettings.thinking)
    ? modelSettings.thinking
    : undefined;
  if (thinking?.type === "disabled") return undefined;
  const nestedReasoning = isRecord(modelSettings.reasoning)
    ? modelSettings.reasoning
    : undefined;
  const modelId = modelHandle?.slice(modelHandle.indexOf("/") + 1);
  const preserveMax = modelId?.startsWith("gpt-5.6") === true;
  return (
    thinkingLevelSetting(nestedReasoning?.reasoning_effort, preserveMax) ??
    thinkingLevelSetting(modelSettings.effort, preserveMax) ??
    thinkingLevelSetting(modelSettings.reasoning_effort, preserveMax)
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
  /**
   * Per-backend pi-ai Models runtime. Runtime-managed providers (local
   * endpoints and mod registrations) resolve to the complete Model object
   * published by the provider that discovered it; a call-scoped runtime is
   * created when omitted. Models are never fabricated from name strings.
   */
  modelsRuntime?: LocalPiModelsRuntime;
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

  const handleProvider = resolveProviderFromModelHandle(model);
  if (handleProvider) return handleProvider;

  const settingsProvider = resolveProviderFromProviderType(
    modelSettings.provider_type,
  );
  if (settingsProvider) return settingsProvider;

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

function fallbackCatalogModelId(
  provider: string,
  modelId: string,
): string | undefined {
  if (provider !== "openai") return undefined;
  const withoutReleaseDate = modelId.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return withoutReleaseDate === modelId ? undefined : withoutReleaseDate;
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

function nonNullHeaders(
  headers: Record<string, string | null>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  );
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

function numericSetting(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
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
  const concreteModelHandle = normalizeOpenAICompatibleLocalModelHandle(
    isUnselectedLocalModelHandle(modelHandle) ? undefined : modelHandle,
  );
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
  // Every resolution goes through a pi-ai Models runtime: the backend's
  // instance when threaded, otherwise a call-scoped one (tests, direct
  // library use). The runtime owns model lookup and credential resolution;
  // Models are never fabricated from name strings.
  const modelsRuntime =
    options.modelsRuntime ??
    new LocalPiModelsRuntime({
      ...(storageDir ? { storageDir } : {}),
    });
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

  if (connection.record?.auth.type === "oauth") {
    // The Models runtime is the credential source of truth: getAuth resolves
    // the stored OAuth token through the auth.json adapter (refreshing under
    // the store's write lock) and derives per-credential request auth such
    // as GitHub Copilot's per-token base URL.
    const authProviderId = registeredProvider
      ? registeredProvider.providerName
      : (spec?.piProvider ?? provider);
    const authResult = await modelsRuntime.getAuth(authProviderId);
    connection = {
      ...connection,
      apiKey: authResult?.auth.apiKey,
    };
    if (authResult?.auth.baseUrl) baseURL = authResult.auth.baseUrl;
    if (authResult?.auth.headers) {
      headers = mergeHeaders(headers, nonNullHeaders(authResult.auth.headers));
    }
    const stored = await modelsRuntime.getStoredCredential(authProviderId);
    oauthCredentials = stored?.type === "oauth" ? stored : undefined;
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

  let model: Model<Api>;
  if (registeredProvider) {
    if (!modelId) {
      throw new Error(
        `No model selected for provider "${provider}". Choose an available model with /model.`,
      );
    }
    const runtimeModel = await modelsRuntime.resolveModel(provider, modelId);
    if (!runtimeModel) {
      throw new Error(
        `Unknown model "${modelId}" for registered provider "${provider}".`,
      );
    }
    // Deep-copy before handing to the mod's modifyModels so a mutating mod
    // cannot corrupt the provider-published instance (including nested
    // arrays/objects like input, cost, and compat).
    const oauthModel =
      oauthCredentials && registeredProvider.config.oauth?.modifyModels
        ? (registeredProvider.config.oauth.modifyModels(
            [structuredClone(runtimeModel)],
            oauthCredentials,
          )[0] ?? runtimeModel)
        : runtimeModel;
    model =
      contextWindow || maxTokens
        ? withOverrides(oauthModel, { contextWindow, maxTokens })
        : oauthModel;
  } else if (!spec) {
    throw new Error(
      `Unknown model "${modelId}" for provider "${provider}". ` +
        "Register the provider with models before using it.",
    );
  } else if (modelsRuntime.isRuntimeManagedProvider(spec.id)) {
    if (!modelId) {
      throw new Error(
        `No model selected for provider "${provider}". Choose an available model with /model.`,
      );
    }
    const runtimeModel = await modelsRuntime.resolveModel(spec.id, modelId);
    if (!runtimeModel) {
      throw new Error(
        `Unknown model "${modelId}" for provider "${provider}". ` +
          "Check that the model is installed on the endpoint or choose another model with /model.",
      );
    }
    // The provider-published Model is authoritative (capabilities, context
    // window, base URL). Only explicit agent settings may override it.
    model =
      contextWindow || maxTokens || headers
        ? withOverrides(runtimeModel, { headers, contextWindow, maxTokens })
        : runtimeModel;
  } else {
    const piProvider = spec.piProvider;
    const fallbackModelId = piProvider
      ? fallbackCatalogModelId(piProvider, modelId)
      : undefined;
    const catalogModel = piProvider
      ? (modelsRuntime.getModel(piProvider, modelId) ??
        (fallbackModelId
          ? modelsRuntime.getModel(piProvider, fallbackModelId)
          : undefined))
      : undefined;
    if (!catalogModel) {
      throw new Error(
        `Unknown model "${modelId}" for provider "${provider}". ` +
          "Check the model handle or update the model catalog.",
      );
    }
    // The runtime-published Model is the turn model. Clone only when an
    // effective override applies; headers stay per-request stream options.
    const overrides = {
      ...(baseURL && baseURL !== catalogModel.baseUrl ? { baseURL } : {}),
      ...(contextWindow && contextWindow !== catalogModel.contextWindow
        ? { contextWindow }
        : {}),
      ...(maxTokens && maxTokens !== catalogModel.maxTokens
        ? { maxTokens }
        : {}),
    };
    model =
      Object.keys(overrides).length > 0
        ? withOverrides(catalogModel, overrides)
        : catalogModel;
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
