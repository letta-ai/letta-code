import type {
  Model,
  Provider,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const LOCAL_ENDPOINT_DEFAULT_CONTEXT_WINDOW = 128000;
const LOCAL_ENDPOINT_DEFAULT_MAX_TOKENS = 32000;
const LOCAL_ENDPOINT_DISCOVERY_TIMEOUT_MS = 2_000;

export type LocalEndpointModel = Model<"openai-completions">;

/**
 * Engine metadata for one discovered model. `vision`/`thinking` left
 * undefined mean the engine did not report the capability — the model is
 * published conservatively (text-only, non-reasoning), never guessed from
 * the model name.
 */
export interface LocalEndpointModelMetadata {
  id: string;
  vision?: boolean;
  thinking?: boolean;
  contextLength?: number;
}

export interface LocalEndpointDiscoveryContext {
  /** GET (or POST when `body` is set) returning parsed JSON; throws on !ok. */
  fetchJson(url: string, init?: { body?: unknown }): Promise<unknown>;
  /** Engine-native base URL (no trailing `/v1`). */
  nativeBaseURL: string;
  /** OpenAI-compatible base URL (with `/v1`), used for turn requests. */
  openAIBaseURL: string;
  /** Models published by the previous refresh, for per-model fallback. */
  lastKnown: ReadonlyMap<string, LocalEndpointModel>;
  /**
   * Provider-instance scratch state persisted across refreshes, for
   * engine-specific caching (e.g. skipping per-model metadata fetches when
   * the engine reports an unchanged digest).
   */
  state: Map<string, unknown>;
  /** Builds the complete pi-ai Model from engine metadata. */
  buildModel(metadata: LocalEndpointModelMetadata): LocalEndpointModel;
}

export type LocalEndpointDiscover = (
  context: LocalEndpointDiscoveryContext,
) => Promise<LocalEndpointModel[]>;

export interface LocalEndpointPiProviderOptions {
  id: string;
  name: string;
  /** Base URL as configured; `/v1` is appended/stripped as needed. */
  baseURL: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  discoveryTimeoutMs?: number;
  discover: LocalEndpointDiscover;
}

/** Strips a trailing `/v1` to reach the engine-native API surface. */
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

/**
 * Real dynamic pi-ai Provider for an OpenAI-compatible local engine. The
 * provider owns keyless/keyed auth, model discovery, complete Model
 * construction from authoritative engine metadata, and stream dispatch; the
 * same Model instance serves /model listing and turn execution.
 *
 * Only the `discover` callback is engine-specific: each engine exposes its
 * capability metadata on a different native API (Ollama `POST /api/show`,
 * llama.cpp `GET /props`, LM Studio `GET /api/v0/models`), so discovery is
 * a per-engine translation into `LocalEndpointModelMetadata`. Everything
 * else — timeout/auth handling, last-known retention on refresh failure,
 * provider wiring — is shared here.
 */
export function createLocalEndpointPiProvider(
  options: LocalEndpointPiProviderOptions,
): Provider<"openai-completions"> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs =
    options.discoveryTimeoutMs ?? LOCAL_ENDPOINT_DISCOVERY_TIMEOUT_MS;
  const nativeBaseURL = localEndpointNativeBaseURL(options.baseURL);
  const openAIBaseURL = localEndpointOpenAIBaseURL(options.baseURL);
  let lastKnown = new Map<string, LocalEndpointModel>();
  const state = new Map<string, unknown>();

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
    return {
      id: metadata.id,
      name: metadata.id,
      api: "openai-completions",
      provider: options.id,
      baseUrl: openAIBaseURL,
      reasoning: metadata.thinking === true,
      input: metadata.vision === true ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow:
        metadata.contextLength ?? LOCAL_ENDPOINT_DEFAULT_CONTEXT_WINDOW,
      maxTokens: LOCAL_ENDPOINT_DEFAULT_MAX_TOKENS,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
    };
  }

  async function fetchModels(
    context: RefreshModelsContext,
  ): Promise<readonly LocalEndpointModel[]> {
    if (!context.allowNetwork) return [...lastKnown.values()];
    const models = await options.discover({
      fetchJson,
      nativeBaseURL,
      openAIBaseURL,
      lastKnown,
      state,
      buildModel,
    });
    lastKnown = new Map(models.map((model) => [model.id, model]));
    return models;
  }

  return createProvider<"openai-completions">({
    id: options.id,
    name: options.name,
    baseUrl: openAIBaseURL,
    auth: {
      apiKey: {
        name: `${options.name} API key`,
        resolve: async ({ credential }) => ({
          auth: { apiKey: credential?.key ?? options.apiKey ?? "not-needed" },
          source: options.apiKey ? "local provider record" : "keyless",
        }),
      },
    },
    // Static baseline stays empty: pi-ai merges the baseline with the
    // dynamic overlay by id, and discovered engine models must disappear
    // when the engine no longer lists them.
    models: [],
    fetchModels,
    api: openAICompletionsApi(),
  });
}
