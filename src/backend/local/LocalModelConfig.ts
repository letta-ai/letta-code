import { DEFAULT_PI_PROVIDER, type PiProvider } from "../dev/PiModelFactory";
import {
  getPiProviderSpec,
  listCatalogModelsForProvider,
  listConfiguredPiProviders,
  localModelHandle,
  localProviderType,
  resolveLocalModel,
} from "../dev/PiProviderRegistry";
import {
  type LocalProviderRecord,
  listLocalProviderRecords,
} from "./LocalProviderAuthStore";

export interface LocalModelConfig {
  provider: PiProvider;
  model: string;
  handle: string;
  modelSettings: Record<string, unknown>;
}

interface LocalModelListEntry {
  handle: string;
  model: string;
  model_endpoint_type: string;
}

interface ListLocalModelsOptions {
  fetch?: typeof fetch;
  discoveryTimeoutMs?: number;
}

const LOCAL_MODEL_DISCOVERY_TIMEOUT_MS = 2_000;

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

function apiKeyFromRecord(
  record: LocalProviderRecord | undefined,
): string | undefined {
  return record?.auth.type === "api" ? record.auth.key : undefined;
}

function isDiscoverableLocalProvider(provider: PiProvider): boolean {
  return getPiProviderSpec(provider).localModelDiscovery !== undefined;
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
  const apiKey = apiKeyFromRecord(record) ?? spec.apiKeyEnv?.();
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

function localProviderNames(storageDir?: string): Set<string> {
  return localProviderNamesFromRecords(listLocalProviderRecords(storageDir));
}

export function resolveLocalProvider(storageDir?: string): PiProvider {
  return (
    listConfiguredPiProviders(localProviderNames(storageDir))[0] ??
    DEFAULT_PI_PROVIDER
  );
}

export { localModelHandle, localProviderType, resolveLocalModel };

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

export async function listLocalModels(
  storageDir?: string,
  options: ListLocalModelsOptions = {},
) {
  const records = listLocalProviderRecords(storageDir);
  const providerNames = localProviderNamesFromRecords(records);
  const configured = resolveLocalModelConfig(storageDir);
  const models: LocalModelListEntry[] = [];
  const addModel = (provider: PiProvider, model: string) => {
    const handle = localModelHandle(provider, model);
    if (models.some((entry) => entry.handle === handle)) return;
    models.push({
      handle,
      model: handle,
      model_endpoint_type: localProviderType(provider),
    });
  };

  if (!isDiscoverableLocalProvider(configured.provider)) {
    addModel(configured.provider, configured.model);
  }
  const discoveryOptions: Required<ListLocalModelsOptions> = {
    fetch: options.fetch ?? fetch,
    discoveryTimeoutMs:
      parsePositiveNumber(options.discoveryTimeoutMs) ??
      LOCAL_MODEL_DISCOVERY_TIMEOUT_MS,
  };
  for (const provider of listConfiguredPiProviders(providerNames)) {
    if (isDiscoverableLocalProvider(provider)) {
      try {
        for (const model of await discoverModelIdsForProvider(
          provider,
          records,
          discoveryOptions,
        )) {
          addModel(provider, model);
        }
      } catch {
        // Do not surface stale guessed models when a local provider is not
        // reachable; simply omit that provider's catalog from /model.
      }
    } else {
      for (const model of listCatalogModelsForProvider(provider)) {
        addModel(provider, model);
      }
    }
  }
  return models;
}
