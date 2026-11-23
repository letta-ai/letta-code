import type {
  Model,
  Provider,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const LOCAL_ENDPOINT_DEFAULT_CONTEXT_WINDOW = 128000;
const LOCAL_ENDPOINT_DEFAULT_MAX_TOKENS = 32000;
const LOCAL_ENDPOINT_DISCOVERY_TIMEOUT_MS = 2_000;

export type LocalEndpointModel = Model<"openai-completions">;

export interface LocalEndpointModelMetadata {
  id: string;
  vision?: boolean;
  thinking?: boolean;
  contextLength?: number;
  maxTokens?: number;
  compat?: Model<"openai-completions">["compat"];
}

export interface LocalEndpointDiscoveryContext {
  fetchJson(url: string, init?: { body?: unknown }): Promise<unknown>;
  nativeBaseURL: string;
  openAIBaseURL: string;
  lastKnown: ReadonlyMap<string, LocalEndpointModel>;
  metadataFingerprints: ReadonlyMap<string, string>;
  nextMetadataFingerprints: Map<string, string>;
  buildModel(metadata: LocalEndpointModelMetadata): LocalEndpointModel;
}

export type LocalEndpointDiscover = (
  context: LocalEndpointDiscoveryContext,
) => Promise<LocalEndpointModel[]>;

export interface LocalEndpointPiProviderOptions {
  id: string;
  name: string;
  baseURL: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  discoveryTimeoutMs?: number;
  discover: LocalEndpointDiscover;
}

export function localEndpointNativeBaseURL(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -"/v1".length) : trimmed;
}

export function localEndpointOpenAIBaseURL(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function modelIdsFromOpenAICompatibleList(data: unknown): string[] {
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

export function createLocalEndpointPiProvider(
  options: LocalEndpointPiProviderOptions,
): Provider<"openai-completions"> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs =
    options.discoveryTimeoutMs ?? LOCAL_ENDPOINT_DISCOVERY_TIMEOUT_MS;
  const nativeBaseURL = localEndpointNativeBaseURL(options.baseURL);
  const openAIBaseURL = localEndpointOpenAIBaseURL(options.baseURL);
  let metadataFingerprints = new Map<string, string>();

  async function fetchJson(
    url: string,
    init: { body?: unknown } = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (options.apiKey && options.apiKey !== "not-needed") {
        headers.Authorization = `Bearer ${options.apiKey}`;
      }
      if (init.body !== undefined) {
        headers["Content-Type"] = "application/json";
      }
      const response = await fetchImpl(url, {
        method: init.body === undefined ? "GET" : "POST",
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
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

  function buildModel(
    metadata: LocalEndpointModelMetadata,
  ): LocalEndpointModel {
    const contextWindow = Math.min(
      metadata.contextLength ?? LOCAL_ENDPOINT_DEFAULT_CONTEXT_WINDOW,
      LOCAL_ENDPOINT_DEFAULT_CONTEXT_WINDOW,
    );
    const maxTokens = Math.min(
      metadata.maxTokens ?? LOCAL_ENDPOINT_DEFAULT_MAX_TOKENS,
      contextWindow,
    );
    return {
      id: metadata.id,
      name: metadata.id,
      api: "openai-completions",
      provider: options.id,
      baseUrl: openAIBaseURL,
      reasoning: metadata.thinking === true,
      input: metadata.vision === true ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        ...metadata.compat,
      },
    };
  }

  async function fetchModels(
    context: RefreshModelsContext,
  ): Promise<readonly LocalEndpointModel[]> {
    const stored = context.stored?.models ?? [];
    const lastKnown = new Map(
      stored
        .filter((model) => model.provider === options.id)
        .map((model) => [model.id, model as LocalEndpointModel]),
    );
    if (!context.allowNetwork) return [...lastKnown.values()];
    const nextMetadataFingerprints = new Map<string, string>();
    const models = await options.discover({
      fetchJson,
      nativeBaseURL,
      openAIBaseURL,
      lastKnown,
      metadataFingerprints,
      nextMetadataFingerprints,
      buildModel,
    });
    metadataFingerprints = nextMetadataFingerprints;
    return models;
  }

  return createProvider<"openai-completions">({
    id: options.id,
    name: options.name,
    baseUrl: openAIBaseURL,
    auth: {
      apiKey: {
        name: `${options.name} API key`,
        resolve: async ({ credential }) => {
          const apiKey = credential?.key ?? options.apiKey;
          return apiKey
            ? {
                auth:
                  apiKey === "not-needed"
                    ? { apiKey, headers: { Authorization: null } }
                    : { apiKey },
                source: "local provider record",
              }
            : undefined;
        },
      },
    },
    models: [],
    fetchModels,
    api: openAICompletionsApi(),
  });
}
