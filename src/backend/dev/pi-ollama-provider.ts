import type { Model, Provider } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const OLLAMA_PI_PROVIDER_ID = "ollama";

const OLLAMA_DEFAULT_CONTEXT_WINDOW = 128000;
const OLLAMA_DEFAULT_MAX_TOKENS = 32000;
const OLLAMA_DISCOVERY_TIMEOUT_MS = 2_000;

export interface OllamaPiProviderOptions {
  /** OpenAI-compatible base URL used for turn requests (`.../v1`). */
  baseURL: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  discoveryTimeoutMs?: number;
  /** Last-known models carried over from a replaced provider instance. */
  initialModels?: readonly Model<"openai-completions">[];
}

/**
 * Strips a trailing `/v1` to reach Ollama's native API (`/api/tags`,
 * `/api/show`), which is where authoritative model metadata lives. The
 * OpenAI-compatible surface has no capability metadata.
 */
export function ollamaNativeBaseURL(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -"/v1".length) : trimmed;
}

function ollamaOpenAICompatibleBaseURL(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

interface OllamaShowResponse {
  capabilities: string[];
  contextLength?: number;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parseOllamaTags(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const models = (data as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return models
    .map((entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const record = entry as { name?: unknown; model?: unknown };
      const id = record.name ?? record.model;
      return typeof id === "string" && id.length > 0 ? id : undefined;
    })
    .filter((id): id is string => id !== undefined);
}

function parseOllamaShow(data: unknown): OllamaShowResponse {
  if (!data || typeof data !== "object") return { capabilities: [] };
  const record = data as { capabilities?: unknown; model_info?: unknown };
  const capabilities = stringArray(record.capabilities);
  const modelInfo =
    record.model_info && typeof record.model_info === "object"
      ? (record.model_info as Record<string, unknown>)
      : undefined;
  const architecture =
    typeof modelInfo?.["general.architecture"] === "string"
      ? (modelInfo["general.architecture"] as string)
      : undefined;
  const contextLength = architecture
    ? modelInfo?.[`${architecture}.context_length`]
    : undefined;
  return {
    capabilities,
    ...(typeof contextLength === "number" && contextLength > 0
      ? { contextLength }
      : {}),
  };
}

/**
 * Builds the complete pi-ai Model for an installed Ollama model from the
 * engine's authoritative `/api/show` metadata. Capability inference from
 * model-name substrings is intentionally not done here: `capabilities` is the
 * only source of vision/thinking support.
 */
export function ollamaModelFromShowResponse(input: {
  modelId: string;
  baseURL: string;
  show: OllamaShowResponse;
}): Model<"openai-completions"> {
  return {
    id: input.modelId,
    name: input.modelId,
    api: "openai-completions",
    provider: OLLAMA_PI_PROVIDER_ID,
    baseUrl: ollamaOpenAICompatibleBaseURL(input.baseURL),
    reasoning: input.show.capabilities.includes("thinking"),
    input: input.show.capabilities.includes("vision")
      ? ["text", "image"]
      : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: input.show.contextLength ?? OLLAMA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
}

async function fetchOllamaJson(input: {
  fetchImpl: typeof fetch;
  url: string;
  apiKey?: string;
  timeoutMs: number;
  body?: unknown;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (input.apiKey && input.apiKey !== "not-needed") {
      headers.Authorization = `Bearer ${input.apiKey}`;
    }
    if (input.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const response = await input.fetchImpl(input.url, {
      method: input.body === undefined ? "GET" : "POST",
      headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
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

/**
 * Real dynamic pi-ai Provider for a local Ollama endpoint. The provider owns
 * discovery (`/api/tags`), authoritative capability metadata (`/api/show`),
 * the published Model objects, and stream dispatch; the same Model instance
 * serves /model listing and turn execution.
 *
 * Refresh failures propagate to the caller while the provider retains its
 * last-known model list (createProvider semantics), so a transient endpoint
 * outage cannot brick turns on an already-discovered model.
 */
export function createOllamaPiProvider(
  options: OllamaPiProviderOptions,
): Provider<"openai-completions"> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.discoveryTimeoutMs ?? OLLAMA_DISCOVERY_TIMEOUT_MS;
  const nativeBaseURL = ollamaNativeBaseURL(options.baseURL);
  let lastKnown = new Map<string, Model<"openai-completions">>(
    (options.initialModels ?? []).map((model) => [model.id, model]),
  );

  async function refreshModels(): Promise<
    readonly Model<"openai-completions">[]
  > {
    const tags = await fetchOllamaJson({
      fetchImpl,
      url: `${nativeBaseURL}/api/tags`,
      apiKey: options.apiKey,
      timeoutMs,
    });
    const modelIds = parseOllamaTags(tags);
    const models = await Promise.all(
      modelIds.map(async (modelId) => {
        try {
          const show = await fetchOllamaJson({
            fetchImpl,
            url: `${nativeBaseURL}/api/show`,
            apiKey: options.apiKey,
            timeoutMs,
            body: { model: modelId },
          });
          return ollamaModelFromShowResponse({
            modelId,
            baseURL: options.baseURL,
            show: parseOllamaShow(show),
          });
        } catch {
          // Metadata fetch failed for this one model: keep its last-known
          // published Model rather than guessing capabilities. A never-seen
          // model is published text-only until /api/show succeeds.
          return (
            lastKnown.get(modelId) ??
            ollamaModelFromShowResponse({
              modelId,
              baseURL: options.baseURL,
              show: { capabilities: [] },
            })
          );
        }
      }),
    );
    lastKnown = new Map(models.map((model) => [model.id, model]));
    return models;
  }

  return createProvider<"openai-completions">({
    id: OLLAMA_PI_PROVIDER_ID,
    name: "Ollama",
    baseUrl: ollamaOpenAICompatibleBaseURL(options.baseURL),
    auth: {
      apiKey: {
        name: "Ollama API key",
        resolve: async ({ credential }) => ({
          auth: { apiKey: credential?.key ?? options.apiKey ?? "not-needed" },
          source: options.apiKey ? "local provider record" : "keyless",
        }),
      },
    },
    models: options.initialModels ?? [],
    refreshModels,
    api: openAICompletionsApi(),
  });
}
