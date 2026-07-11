import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import {
  DEFAULT_PI_PROVIDER,
  isUnselectedLocalModelHandle,
  type PiProvider,
  UNSELECTED_LOCAL_MODEL_HANDLE,
} from "@/backend/dev/pi-model-factory";
import {
  getRegisteredPiProvider,
  listRegisteredPiProviders,
  resolveRegisteredPiProviderFromModelHandle,
  stripRegisteredProviderHandlePrefix,
} from "@/backend/dev/pi-provider-mod-registry";
import {
  getPiProviderSpec,
  isPiProvider,
  listCatalogModelsForProvider,
  listConfiguredPiProviders,
  localModelHandle,
  localProviderType,
  PI_PROVIDER_SPECS,
  resolveLocalModel,
  resolveProviderFromModelHandle,
  resolveProviderFromProviderType,
  stripProviderHandlePrefix,
} from "@/backend/dev/pi-provider-registry";
import {
  isRegisteredPiProviderConfigured,
  listRegisteredPiProviderModels,
  resolveRegisteredPiProviderListModelsConnection,
} from "@/backend/dev/registered-pi-provider-runtime";
import {
  type LocalProviderRecord,
  listLocalProviderRecords,
  localProviderApiKeyFromRecord,
} from "./local-provider-auth-store";

export interface LocalModelConfig {
  provider: PiProvider;
  model: string;
  handle: string;
  modelSettings: Record<string, unknown>;
}

export { UNSELECTED_LOCAL_MODEL_HANDLE };

interface LocalModelListEntry {
  handle: string;
  max_context_window?: number;
  model: string;
  model_endpoint_type: string;
}

interface ListLocalModelsOptions {
  fetch?: typeof fetch;
  discoveryTimeoutMs?: number;
  autoDetectDiscoveryTimeoutMs?: number;
}

const LOCAL_MODEL_DISCOVERY_TIMEOUT_MS = 2_000;
const LOCAL_MODEL_AUTODETECT_DISCOVERY_TIMEOUT_MS = 500;

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function parsePositiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function modelIdsFromOpenAICompatibleResponse(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const records = (data as { data?: unknown }).data;
  if (!Array.isArray(records)) return [];
  return records
    .map((entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const id = (entry as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0 ? id : undefined;
    })
    .filter((id): id is string => id !== undefined);
}

function modelIdsFromOllamaTagsResponse(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const records = (data as { models?: unknown }).models;
  if (!Array.isArray(records)) return [];
  return records
    .map((entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const record = entry as { name?: unknown; model?: unknown };
      const id = record.name ?? record.model;
      return typeof id === "string" && id.length > 0 ? id : undefined;
    })
    .filter((id): id is string => id !== undefined);
}

async function fetchJsonWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  options: {
    apiKey?: string;
    timeoutMs: number;
  },
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.apiKey && options.apiKey !== "not-needed") {
      headers.Authorization = `Bearer ${options.apiKey}`;
    }
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function openAICompatibleModelListUrls(baseURL: string): string[] {
  const base = trimTrailingSlashes(baseURL);
  const urls = new Set<string>();
  urls.add(`${base}/models`);
  if (!base.endsWith("/v1")) {
    urls.add(`${base}/v1/models`);
  }
  return [...urls];
}

function ollamaNativeModelListUrl(baseURL: string): string {
  const url = new URL(baseURL);
  url.pathname = url.pathname.replace(/\/?v1\/?$/, "");
  return `${trimTrailingSlashes(url.toString())}/api/tags`;
}

async function discoverOpenAICompatibleModelIds(input: {
  baseURL: string;
  apiKey?: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<string[]> {
  let lastError: unknown;
  for (const url of openAICompatibleModelListUrls(input.baseURL)) {
    try {
      const data = await fetchJsonWithTimeout(input.fetchImpl, url, input);
      const ids = modelIdsFromOpenAICompatibleResponse(data);
      if (ids.length > 0) return ids;
      lastError = new Error("Invalid model list response");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to discover local models");
}

async function discoverOllamaModelIds(input: {
  baseURL: string;
  apiKey?: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<string[]> {
  try {
    return await discoverOpenAICompatibleModelIds(input);
  } catch (openAIError) {
    try {
      const data = await fetchJsonWithTimeout(
        input.fetchImpl,
        ollamaNativeModelListUrl(input.baseURL),
        input,
      );
      const ids = modelIdsFromOllamaTagsResponse(data);
      if (ids.length > 0) return ids;
    } catch {
      // Surface the OpenAI-compatible failure below; it is the endpoint used by
      // the provider runtime and usually has the more relevant error.
    }
    throw openAIError instanceof Error
      ? openAIError
      : new Error("Failed to discover Ollama models");
  }
}

function localProviderNamesFromRecords(
  records: readonly LocalProviderRecord[],
): Set<string> {
  return new Set(records.map((record) => record.name));
}

function providerRecordFor(
  provider: PiProvider,
  records: readonly LocalProviderRecord[],
): LocalProviderRecord | undefined {
  const names = getPiProviderSpec(provider).localProviderNames;
  return records.find((record) => names.includes(record.name));
}

function isDiscoverableLocalProvider(provider: PiProvider): boolean {
  return getPiProviderSpec(provider).localModelDiscovery !== undefined;
}

function isAutoDetectableLocalEndpointProvider(provider: PiProvider): boolean {
  return getPiProviderSpec(provider).autoDetectLocalEndpoint === true;
}

function isPiProviderForLocalModelHandle(
  provider: PiProvider | string,
): provider is PiProvider {
  return isPiProvider(provider);
}

async function discoverModelIdsForProvider(
  provider: PiProvider,
  records: readonly LocalProviderRecord[],
  options: Required<ListLocalModelsOptions>,
): Promise<string[]> {
  const spec = getPiProviderSpec(provider);
  const discovery = spec.localModelDiscovery;
  if (!discovery) return [];

  const record = providerRecordFor(provider, records);
  const baseURL =
    record?.base_url ?? spec.baseUrlEnv?.() ?? spec.defaultBaseURL;
  if (!baseURL) return [];
  const apiKey = localProviderApiKeyFromRecord(record) ?? spec.apiKeyEnv?.();
  const input = {
    baseURL,
    apiKey,
    fetchImpl: options.fetch,
    timeoutMs: options.discoveryTimeoutMs,
  };

  switch (discovery) {
    case "ollama":
      return discoverOllamaModelIds(input);
    case "openai-compatible":
      return discoverOpenAICompatibleModelIds(input);
  }
}

export function resolveLocalProvider(storageDir?: string): PiProvider {
  const records = listLocalProviderRecords(storageDir);
  const registeredProvider = listRegisteredPiProviders().find(
    (provider) =>
      isRegisteredPiProviderConfigured(provider, records) &&
      (provider.config.models?.length ?? 0) > 0,
  );
  if (registeredProvider) return registeredProvider.providerName as PiProvider;
  return (
    listConfiguredPiProviders(localProviderNamesFromRecords(records))[0] ??
    DEFAULT_PI_PROVIDER
  );
}

export { localModelHandle, localProviderType, resolveLocalModel };

function localProviderTypeForModelConfig(
  provider: PiProvider | string,
): string {
  return isPiProviderForLocalModelHandle(provider)
    ? localProviderType(provider)
    : provider;
}

function registeredModelSettingsForProviderModel(
  provider: PiProvider | string,
  modelId: string | undefined,
): Record<string, unknown> | undefined {
  if (!modelId) return undefined;
  const registeredProvider = getRegisteredPiProvider(provider);
  const registeredModel = registeredProvider?.config.models?.find(
    (model) => model.id === modelId,
  );
  if (!registeredModel) return undefined;
  return {
    provider_type: localProviderTypeForModelConfig(provider),
    context_window_limit: registeredModel.contextWindow,
    max_tokens: registeredModel.maxTokens,
  };
}

function catalogModelSettingsForProviderModel(
  provider: PiProvider,
  modelId: string | undefined,
): Record<string, unknown> | undefined {
  if (!modelId || !isPiProvider(provider)) return undefined;
  const spec = getPiProviderSpec(provider);
  if (!spec.piProvider) return undefined;
  const model = (getModels(spec.piProvider) as Model<Api>[]).find(
    (entry) => entry.id === modelId,
  );
  if (!model) return undefined;
  return {
    provider_type: localProviderTypeForModelConfig(provider),
    context_window_limit: model.contextWindow,
    max_tokens: model.maxTokens,
  };
}

export function localModelSettingsForHandle(
  handle: string | undefined,
): Record<string, unknown> | undefined {
  if (!handle) return undefined;
  const registeredProvider = resolveRegisteredPiProviderFromModelHandle(handle);
  if (registeredProvider) {
    return registeredModelSettingsForProviderModel(
      registeredProvider,
      stripRegisteredProviderHandlePrefix(handle, registeredProvider),
    );
  }

  const provider = resolveProviderFromModelHandle(handle);
  if (!provider) return undefined;
  const modelId = stripProviderHandlePrefix(handle, provider);
  return (
    registeredModelSettingsForProviderModel(provider, modelId) ??
    catalogModelSettingsForProviderModel(provider, modelId)
  );
}

export function resolveLocalModelConfig(storageDir?: string): LocalModelConfig {
  const provider = resolveLocalProvider(storageDir);
  const registeredProvider = getRegisteredPiProvider(provider);
  const registeredModel = registeredProvider?.config.models?.[0];
  const defaultModel = registeredProvider
    ? undefined
    : resolveLocalModel(provider);
  const model =
    registeredModel?.id ??
    (registeredProvider ? "default" : defaultModel) ??
    UNSELECTED_LOCAL_MODEL_HANDLE;
  const handle = registeredProvider
    ? `${provider}/${model}`
    : model === UNSELECTED_LOCAL_MODEL_HANDLE
      ? UNSELECTED_LOCAL_MODEL_HANDLE
      : localModelHandle(provider, model);
  const modelSettings = localModelSettingsForHandle(handle);
  return {
    provider,
    model,
    handle,
    modelSettings: {
      provider_type: localProviderTypeForModelConfig(provider),
      ...(modelSettings ?? {}),
    },
  };
}

function providerForLocalModelListEntry(
  entry: LocalModelListEntry,
): PiProvider | undefined {
  return (
    resolveProviderFromModelHandle(entry.handle) ??
    resolveProviderFromProviderType(entry.model_endpoint_type)
  );
}

export async function resolveAvailableLocalModelForTurn(input: {
  model?: string | null;
  modelSettings?: Record<string, unknown> | null;
  storageDir?: string;
}): Promise<{ model?: string; modelSettings: Record<string, unknown> }> {
  const baseSettings = { ...(input.modelSettings ?? {}) };
  if (
    typeof input.model === "string" &&
    !isUnselectedLocalModelHandle(input.model)
  ) {
    return { model: input.model, modelSettings: baseSettings };
  }

  const preferredProvider = resolveProviderFromProviderType(
    baseSettings.provider_type,
  );
  const models = await listLocalModels(input.storageDir);
  const selected = preferredProvider
    ? models.find(
        (entry) => providerForLocalModelListEntry(entry) === preferredProvider,
      )
    : models[0];

  if (!selected) {
    return { model: undefined, modelSettings: baseSettings };
  }

  return {
    model: selected.handle,
    modelSettings: {
      ...baseSettings,
      ...localModelSettingsForHandle(selected.handle),
      provider_type: selected.model_endpoint_type,
    },
  };
}

// Temporary entitlement guard: remove Luna from this set once OpenAI enables
// it through ChatGPT OAuth and LET-9572 is resolved. Direct OpenAI Luna remains
// available because this filter is scoped to the chatgpt_oauth provider type.
const UNSUPPORTED_LOCAL_CHATGPT_OAUTH_MODELS = new Set(["gpt-5.6-luna"]);

function shouldIncludeLocalModel(
  provider: PiProvider | string,
  model: string,
): boolean {
  const modelId = isPiProvider(provider)
    ? (stripProviderHandlePrefix(model, provider) ?? model)
    : model;
  return !(
    localProviderTypeForModelConfig(provider) === "chatgpt_oauth" &&
    UNSUPPORTED_LOCAL_CHATGPT_OAUTH_MODELS.has(modelId)
  );
}

export async function listLocalModels(
  storageDir?: string,
  options: ListLocalModelsOptions = {},
) {
  const records = listLocalProviderRecords(storageDir);
  const providerNames = localProviderNamesFromRecords(records);
  const configured = resolveLocalModelConfig(storageDir);
  const models: LocalModelListEntry[] = [];
  const registeredProviders = listRegisteredPiProviders();
  const registeredProvidersWithModels = new Set(
    registeredProviders
      .filter((provider) => provider.config.models !== undefined)
      .map((provider) => provider.providerName),
  );
  const addModel = (
    provider: PiProvider | string,
    model: string,
    options: {
      handle?: string;
      maxContextWindow?: number;
      modelEndpointType?: string;
    } = {},
  ) => {
    if (!shouldIncludeLocalModel(provider, model)) return;
    const handle =
      options.handle ??
      (typeof provider === "string" &&
      !isPiProviderForLocalModelHandle(provider)
        ? `${provider}/${model}`
        : localModelHandle(provider as PiProvider, model));
    if (models.some((entry) => entry.handle === handle)) return;
    const modelSettings = localModelSettingsForHandle(handle);
    const maxContextWindow =
      options.maxContextWindow ??
      (typeof modelSettings?.context_window_limit === "number"
        ? modelSettings.context_window_limit
        : undefined);
    models.push({
      handle,
      ...(maxContextWindow ? { max_context_window: maxContextWindow } : {}),
      model: handle,
      model_endpoint_type:
        options.modelEndpointType ?? localProviderTypeForModelConfig(provider),
    });
  };

  for (const provider of registeredProviders) {
    if (!isRegisteredPiProviderConfigured(provider, records)) continue;
    try {
      for (const model of await listRegisteredPiProviderModels(
        provider,
        await resolveRegisteredPiProviderListModelsConnection(provider, {
          records,
          storageDir,
        }),
      )) {
        addModel(provider.providerName, model.id, {
          handle: `${provider.providerName}/${model.id}`,
          maxContextWindow: model.contextWindow,
          modelEndpointType: provider.providerName,
        });
      }
    } catch {
      for (const model of provider.config.models ?? []) {
        addModel(provider.providerName, model.id, {
          handle: `${provider.providerName}/${model.id}`,
          maxContextWindow: model.contextWindow,
          modelEndpointType: provider.providerName,
        });
      }
    }
  }

  // Only add the configured model if its provider is actually reachable
  // (has keys/env configured). Otherwise we'd show models the user can't use.
  const configuredProviderIsConfigured = listConfiguredPiProviders(
    providerNames,
  ).includes(configured.provider);
  if (
    isPiProviderForLocalModelHandle(configured.provider) &&
    !isDiscoverableLocalProvider(configured.provider) &&
    !registeredProvidersWithModels.has(configured.provider) &&
    configuredProviderIsConfigured
  ) {
    addModel(configured.provider, configured.model);
  }
  const discoveryOptions: Required<ListLocalModelsOptions> = {
    fetch: options.fetch ?? fetch,
    discoveryTimeoutMs:
      parsePositiveNumber(options.discoveryTimeoutMs) ??
      LOCAL_MODEL_DISCOVERY_TIMEOUT_MS,
    autoDetectDiscoveryTimeoutMs:
      parsePositiveNumber(options.autoDetectDiscoveryTimeoutMs) ??
      LOCAL_MODEL_AUTODETECT_DISCOVERY_TIMEOUT_MS,
  };
  const configuredProviders = new Set(listConfiguredPiProviders(providerNames));
  const providersToDiscover = new Set([
    ...configuredProviders,
    ...PI_PROVIDER_SPECS.filter((provider) =>
      isAutoDetectableLocalEndpointProvider(provider.id),
    ).map((provider) => provider.id),
  ]);
  const discoveryResults = await Promise.all(
    [...providersToDiscover].map(async (provider) => {
      if (registeredProvidersWithModels.has(provider)) {
        return { provider, models: [] };
      }

      if (!isDiscoverableLocalProvider(provider)) {
        return { provider, models: listCatalogModelsForProvider(provider) };
      }

      try {
        const timeoutMs = configuredProviders.has(provider)
          ? discoveryOptions.discoveryTimeoutMs
          : discoveryOptions.autoDetectDiscoveryTimeoutMs;
        const discoveredModels = await discoverModelIdsForProvider(
          provider,
          records,
          { ...discoveryOptions, discoveryTimeoutMs: timeoutMs },
        );
        return { provider, models: discoveredModels };
      } catch {
        // Do not surface stale guessed models when a local provider is not
        // reachable; simply omit that provider's catalog from /model.
        return { provider, models: [] };
      }
    }),
  );

  for (const result of discoveryResults) {
    for (const model of result.models) {
      addModel(result.provider, model);
    }
  }
  return models;
}
