import {
  type Api,
  clampThinkingLevel,
  type Model,
  type ModelThinkingLevel,
  type ThinkingLevel,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { localNamesForProviderId } from "@/backend/local/local-pi-credential-store";
import {
  getLocalProviderRecordByName,
  LOCAL_PROVIDER_NO_API_KEY,
  type LocalProviderRecord,
  localProviderApiKeyFromRecord,
} from "@/backend/local/local-provider-auth-store";
import {
  type LocalProviderTimeout,
  resolveLocalProviderTimeout,
} from "@/backend/local/local-provider-timeout";
import { normalizeReasoningEffortForModel } from "@/utils/openai-reasoning-effort";
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
  // pi-ai's public ThinkingLevel currently omits `none`, but ChatGPT GPT-5.6
  // accepts it and rejects the legacy `minimal` alias (LET-11064).
  if (effort === "none") return "none" as ThinkingLevel;
  return effort === "minimal" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh"
    ? effort
    : undefined;
}

function modelIdFromHandle(modelHandle?: string): string | undefined {
  if (!modelHandle) return undefined;
  return modelHandle.slice(modelHandle.indexOf("/") + 1);
}

// zAI GLM-5.3 (and sibling always-on GLM-5 variants) reject
// `thinking: {type: "disabled"}` with code 1210. pi-ai sends that whenever
// `options.reasoning` is absent, so these models need a concrete effort even
// when Letta has no explicit reasoning setting.
function alwaysOnZaiThinking(modelId?: string): boolean {
  return (
    modelId === "glm-5.3" ||
    modelId === "glm-5-turbo" ||
    modelId === "glm-5.2-highspeed"
  );
}

/**
 * TEMPORARY PI-AI COMPATIBILITY PATCH. ADDED 2026-08-24.
 *
 * REMOVE THIS ENTIRE BLOCK after letta-code upgrades to a pi-ai release whose
 * generated OpenRouter catalog translates `reasoning.mandatory` and
 * `reasoning.supported_efforts` into `Model.thinkingLevelMap`.
 *
 * Upstream issue: https://github.com/earendil-works/pi/issues/8454
 *
 * pi-ai 0.84.2 marks these models as reasoning-capable but omits their
 * `thinkingLevelMap`. Its OpenRouter adapter therefore sends
 * `reasoning: { effort: "none" }` when Letta has no selected reasoning level,
 * and these endpoints reject the request because reasoning is mandatory.
 * `off: null` tells pi-ai to omit that field. The other nulls and strings let
 * pi-ai's own `getSupportedThinkingLevels()` and `clampThinkingLevel()` own
 * selector visibility and saved-level clamping.
 *
 * Keep this as model metadata only. Do not add OpenRouter request building,
 * effort ordering, or custom clamping here. Those behaviors belong to pi-ai.
 */
const TEMPORARY_PI_AI_OPENROUTER_THINKING_LEVEL_MAPS: Readonly<
  Record<string, ThinkingLevelMap>
> = {
  "stealth/ox-alpha": {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  },
  "google/gemini-3.7-flash": {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: null,
  },
  "google/gemini-3.7-flash:batch": {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: null,
  },
};

export function patchTemporaryPiAiOpenRouterThinkingMap<TApi extends Api>(
  model: Model<TApi>,
): Model<TApi> {
  if (model.provider !== "openrouter" || model.thinkingLevelMap) return model;
  const thinkingLevelMap =
    TEMPORARY_PI_AI_OPENROUTER_THINKING_LEVEL_MAPS[model.id];
  return thinkingLevelMap
    ? { ...model, reasoning: true, thinkingLevelMap }
    : model;
}

// Maps Letta model settings to a pi-ai ThinkingLevel. Every pi-ai Anthropic
// call against a reasoning-capable model must pass this when available:
// pi-ai sends `thinking: {type: "disabled"}` for reasoning models when
// `options.reasoning` is absent, and adaptive-thinking models (for example
// claude-fable-5) reject that with a 400 invalid_request_error.
export function reasoningForSettings(
  modelSettings: Record<string, unknown>,
  modelHandle?: string,
  model?: Model<Api>,
): ThinkingLevel | undefined {
  const thinking = isRecord(modelSettings.thinking)
    ? modelSettings.thinking
    : undefined;
  const modelId = modelIdFromHandle(modelHandle);
  const preserveMax = modelId?.startsWith("gpt-5.6") === true;
  const nestedReasoning = isRecord(modelSettings.reasoning)
    ? modelSettings.reasoning
    : undefined;
  const rawEffort =
    nestedReasoning?.reasoning_effort ??
    modelSettings.effort ??
    modelSettings.reasoning_effort;
  const explicit = thinkingLevelSetting(
    normalizeReasoningEffortForModel(
      modelHandle,
      typeof rawEffort === "string" ? rawEffort : undefined,
    ),
    preserveMax,
  );
  if (alwaysOnZaiThinking(modelId)) {
    // API accepts low / high / max; low is the cheapest always-on default.
    return explicit === "medium" || explicit === "minimal"
      ? "low"
      : (explicit ?? "low");
  }
  if (
    model?.provider === "openrouter" &&
    model.thinkingLevelMap?.off === null
  ) {
    if (!explicit || explicit === ("none" as ThinkingLevel)) return undefined;
    const clamped = clampThinkingLevel(model, explicit as ModelThinkingLevel);
    return clamped === "off" ? undefined : clamped;
  }
  if (thinking?.type === "disabled") return undefined;
  return explicit;
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
  abortSignal?: AbortSignal;
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
  storageDir?: string,
): {
  apiKey?: string;
  baseURL?: string;
  timeout: LocalProviderTimeout;
  record?: LocalProviderRecord;
} {
  const record = localProviderRecord(providerNames, storageDir);
  return {
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

function isZaiCodingBaseURL(baseURL: string | undefined): boolean {
  return typeof baseURL === "string" && baseURL.includes("/coding/");
}

export function resolveZaiConnection(options: {
  storageDir?: string;
  preferredProviderType?: "zai" | "zai_coding";
  /**
   * Catalog/published model URL. Current GLM models publish the coding-plan
   * endpoint; a lone stored `zai` key should reuse that instead of being
   * forced onto pay-as-you-go `/api/paas/v4`.
   */
  publishedBaseURL?: string;
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
  const reuseRegularKeyOnCodingEndpoint = (): ZaiConnection => ({
    ...codingConnection,
    apiKey: regularKey,
    timeout: regularConnection.timeout,
  });
  const publishedWantsCoding = isZaiCodingBaseURL(options.publishedBaseURL);
  const hasDedicatedCodingRecord = Boolean(codingKey);

  if (options.preferredProviderType === "zai_coding" && codingKey) {
    return codingConnection;
  }
  if (options.preferredProviderType === "zai" && regularKey) {
    // /model zai/glm-* stores provider_type=zai even for coding-plan models.
    // Only stay on pay-as-you-go when a dedicated coding record exists or the
    // catalog model itself is not a coding endpoint.
    if (!hasDedicatedCodingRecord && publishedWantsCoding) {
      return reuseRegularKeyOnCodingEndpoint();
    }
    return regularConnection;
  }
  if (codingKey) return codingConnection;
  if (regularKey) {
    return publishedWantsCoding
      ? reuseRegularKeyOnCodingEndpoint()
      : regularConnection;
  }
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

  // Non-credential connection config only: the stored record's base URL and
  // timeout plus spec defaults. All credential resolution happens in the
  // runtime below.
  const localNames = registeredProvider
    ? localNamesForProviderId(provider)
    : (spec?.localProviderNames ?? [provider]);
  let connection = localProviderConnection(localNames, storageDir);
  let baseURL =
    connection.baseURL ??
    spec?.baseUrlEnv?.() ??
    spec?.defaultBaseURL ??
    registeredProvider?.config.baseUrl;
  let headers = mergeHeaders(spec?.headers?.());
  let providerOptions: Record<string, unknown> | undefined;
  let envOverrides: Record<string, string | undefined> | undefined;
  let oauthCredentials: OAuthCredentials | undefined;

  if (!modelId) {
    throw new Error(
      `No model selected for provider "${provider}". Choose an available model with /model.`,
    );
  }

  // One runtime resolution path for every provider class — registered mods,
  // managed local endpoints, and built-in catalogs. resolveTurn returns the
  // provider-published Model and the resolved auth from one consistent
  // provider state (credential-identity invalidation applied first), so no
  // registered/catalog/auth branching exists here.
  const runtimeProviderId = registeredProvider
    ? provider
    : spec && modelsRuntime.isRuntimeManagedProvider(spec.id)
      ? spec.id
      : spec?.piProvider;
  if (!runtimeProviderId) {
    throw new Error(
      `Unknown model "${modelId}" for provider "${provider}". ` +
        "Register the provider with models before using it.",
    );
  }
  const fallbackModelId =
    !registeredProvider && spec?.piProvider
      ? fallbackCatalogModelId(spec.piProvider, modelId)
      : undefined;
  const { model: publishedModel, auth: authResult } =
    await modelsRuntime.resolveTurn(
      runtimeProviderId,
      modelId,
      fallbackModelId,
      options.abortSignal,
    );
  // The runtime is the sole credential source (stored records, ambient env
  // via the runtime's AuthContext aliases, per-credential OAuth request
  // auth). The one named exception is zai's dual-record endpoint selection.
  connection = {
    ...connection,
    apiKey:
      authResult?.auth.apiKey === LOCAL_PROVIDER_NO_API_KEY
        ? undefined
        : authResult?.auth.apiKey,
  };
  if (authResult?.auth.baseUrl) baseURL = authResult.auth.baseUrl;
  if (authResult?.auth.headers) {
    headers = mergeHeaders(headers, nonNullHeaders(authResult.auth.headers));
  }
  if (connection.record?.auth.type === "oauth") {
    const stored = await modelsRuntime.getStoredCredential(runtimeProviderId);
    oauthCredentials = stored?.type === "oauth" ? stored : undefined;
  }

  if (provider === "zai") {
    const zai = resolveZaiConnection({
      storageDir,
      preferredProviderType:
        preferredProviderType === "zai" ||
        preferredProviderType === "zai_coding"
          ? preferredProviderType
          : undefined,
      publishedBaseURL: publishedModel?.baseUrl,
    });
    connection = {
      apiKey: zai.apiKey,
      baseURL: zai.baseURL,
      timeout: zai.timeout,
    };
    baseURL = zai.baseURL;
  }

  if (provider === "amazon-bedrock") {
    const bedrock = bedrockLocalProviderOptions(connection.record);
    providerOptions = bedrock.providerOptions;
    envOverrides = bedrock.envOverrides;
  }

  if (!publishedModel) {
    throw new Error(
      `Unknown model "${modelId}" for provider "${provider}". ` +
        "Choose an available model with /model.",
    );
  }

  // Mod product hook: per-credential model transformation. Deep-copied so a
  // mutating mod cannot corrupt the provider-published instance.
  const hookedModel = patchTemporaryPiAiOpenRouterThinkingMap(
    oauthCredentials && registeredProvider?.config.oauth?.modifyModels
      ? (registeredProvider.config.oauth.modifyModels(
          [structuredClone(publishedModel)],
          oauthCredentials,
        )[0] ?? publishedModel)
      : publishedModel,
  );

  // Effective-value overrides only: with none, the turn model IS the
  // runtime-published instance — persisted selection settings that merely
  // restate the published values never clone. Base URL overrides apply only
  // to built-in catalog providers (managed endpoints and mods own their
  // base URLs end-to-end).
  const configuredContextWindow = numericSetting(
    modelSettings.context_window_limit,
  );
  // Ollama selection persists architectural catalog values into settings.
  // They must not inflate exact local-daemon serving truth. Other endpoints
  // retain the existing explicit override escape hatch.
  const isLocalOllama =
    modelsRuntime.isBuiltInLocalOllamaProvider(runtimeProviderId);
  const contextWindow =
    configuredContextWindow && isLocalOllama
      ? Math.min(configuredContextWindow, hookedModel.contextWindow)
      : configuredContextWindow;
  const configuredMaxTokens = numericSetting(modelSettings.max_tokens);
  const maxTokens = isLocalOllama
    ? Math.min(
        configuredMaxTokens ?? hookedModel.maxTokens,
        contextWindow ?? hookedModel.contextWindow,
      )
    : configuredMaxTokens;
  const allowBaseUrlOverride =
    !registeredProvider &&
    spec !== undefined &&
    !modelsRuntime.isRuntimeManagedProvider(spec.id);
  const overrides = {
    ...(allowBaseUrlOverride && baseURL && baseURL !== hookedModel.baseUrl
      ? { baseURL }
      : {}),
    ...(contextWindow && contextWindow !== hookedModel.contextWindow
      ? { contextWindow }
      : {}),
    ...(maxTokens && maxTokens !== hookedModel.maxTokens ? { maxTokens } : {}),
  };
  const model: Model<Api> =
    Object.keys(overrides).length > 0
      ? withOverrides(hookedModel, overrides)
      : hookedModel;

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
