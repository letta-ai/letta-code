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
  /** Engine-reported available window; the shared builder applies its default cap. */
  contextLength?: number;
  /** Engine-specific output cap; defaults to the shared constant. */
  maxTokens?: number;
  /** Engine-specific OpenAI-compat overrides merged over the defaults. */
  compat?: Model<"openai-completions">["compat"];
}

export interface LocalEndpointDiscoveryContext {
  /** GET (or POST when `body` is set) returning parsed JSON; throws on !ok. */
  fetchJson(url: string, init?: { body?: unknown }): Promise<unknown>;
  /** Engine-native base URL (no trailing `/v1`). */
  nativeBaseURL: string;
  /** OpenAI-compatible base URL (with `/v1`), used for turn requests. */
  openAIBaseURL: string;
  /**
   * Models from the last successful refresh, read from the pi-ai
   * ModelsStore — the single source of last-known retention.
   */
  lastKnown: ReadonlyMap<string, LocalEndpointModel>;
  /**
   * Engine metadata fingerprints (e.g. Ollama tag digests) from the
   * previous refresh, keyed by model id. Provider-instance-scoped: a
   * connection change rebuilds the provider and discards them. Engines use
   * this to skip expensive per-model metadata fetches when the installed
   * artifact is unchanged; it never stores Model/capability data.
   */
  metadataFingerprints: ReadonlyMap<string, string>;
  /** Fingerprints to persist for the next refresh; engines fill this in. */
  nextMetadataFingerprints: Map<string, string>;
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

export interface OpenAICompatibleListEntry {
  id: string;
  /** Provider-advertised input limit from GET /v1/models, when valid. */
  maxInputTokens?: number;
  /** Provider-advertised output limit from GET /v1/models, when valid. */
  maxOutputTokens?: number;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Parse an OpenAI-compatible GET /v1/models list, keeping each entry's
 * optional limit metadata. Positive-integer limits are kept per field;
 * malformed values (booleans, strings, zero, negatives, NaN/Infinity) are
 * ignored so callers fall back per-field to last-known or harness defaults.
 */
export function openAICompatibleListEntries(
  data: unknown,
): OpenAICompatibleListEntry[] {
  if (!data || typeof data !== "object") return [];
  const records = (data as { data?: unknown }).data;
  if (!Array.isArray(records)) return [];
  const entries: OpenAICompatibleListEntry[] = [];
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const raw = record as {
      id?: unknown;
      max_input_tokens?: unknown;
      max_output_tokens?: unknown;
    };
    if (typeof raw.id !== "string" || raw.id.length === 0) continue;
    const entry: OpenAICompatibleListEntry = { id: raw.id };
    if (isPositiveInteger(raw.max_input_tokens)) {
      entry.maxInputTokens = raw.max_input_tokens;
    }
    if (isPositiveInteger(raw.max_output_tokens)) {
      entry.maxOutputTokens = raw.max_output_tokens;
    }
    entries.push(entry);
  }
  return entries;
}

export function modelIdsFromOpenAICompatibleList(data: unknown): string[] {
  return openAICompatibleListEntries(data).map((entry) => entry.id);
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
  // Provider-instance-scoped fingerprint cache (see
  // LocalEndpointDiscoveryContext.metadataFingerprints).
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
    // Engine catalogs mix loaded runtime windows with architectural maxima.
    // Publish a conservative harness default either way; an explicit
    // /context-limit setting can still clone the Model with a larger window.
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
    // Last-known models come solely from the pi-ai store (the same entry
    // createProvider restores and persists); no parallel model cache.
    const stored = (await context.store.read())?.models ?? [];
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
        // Keyless local daemons pass "not-needed" through the connection's
        // fallback key; a remote endpoint with no key at all resolves
        // undefined so pi-ai treats it as unconfigured.
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
    // Static baseline stays empty: pi-ai merges the baseline with the
    // dynamic overlay by id, and discovered engine models must disappear
    // when the engine no longer lists them.
    models: [],
    fetchModels,
    api: openAICompletionsApi(),
  });
}
