import type { Provider } from "@earendil-works/pi-ai";
import {
  createLocalEndpointPiProvider,
  type LocalEndpointDiscover,
  type LocalEndpointModelMetadata,
  localEndpointNativeBaseURL,
} from "./pi-local-endpoint-provider";

export const OLLAMA_PI_PROVIDER_ID = "ollama";
export const OLLAMA_CLOUD_PI_PROVIDER_ID = "ollama-cloud";

/** Ollama assigns the `latest` tag when a model handle omits one. */
export function normalizeOllamaModelId(modelId: string): string {
  const leaf = modelId.slice(modelId.lastIndexOf("/") + 1);
  return leaf.includes(":") || leaf.includes("@")
    ? modelId
    : `${modelId}:latest`;
}

export interface OllamaPiProviderOptions {
  /** Base URL as configured; `/v1` is appended/stripped as needed. */
  baseURL: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  discoveryTimeoutMs?: number;
  /** Defaults to the local Ollama provider; Ollama Cloud reuses this factory. */
  providerId?: string;
  name?: string;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

interface OllamaTagEntry {
  id: string;
  digest?: string;
}

function parseOllamaTags(data: unknown): OllamaTagEntry[] {
  if (!data || typeof data !== "object") return [];
  const models = (data as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return models
    .map((entry): OllamaTagEntry | undefined => {
      if (!entry || typeof entry !== "object") return undefined;
      const record = entry as {
        name?: unknown;
        model?: unknown;
        digest?: unknown;
      };
      const id = record.name ?? record.model;
      if (typeof id !== "string" || id.length === 0) return undefined;
      return {
        id,
        ...(typeof record.digest === "string" && record.digest.length > 0
          ? { digest: record.digest }
          : {}),
      };
    })
    .filter((entry): entry is OllamaTagEntry => entry !== undefined);
}

/**
 * Runtime context windows from `GET /api/ps`, keyed by model id.
 *
 * `/api/show` reports the architectural maximum baked into the GGUF, which is
 * what the model *could* support — not what the daemon will actually serve.
 * Ollama serves `OLLAMA_CONTEXT_LENGTH` (or a per-request `num_ctx`, which the
 * OpenAI-compatible surface we stream through does not accept) and silently
 * truncates any prompt longer than that: no error, no warning, and the reported
 * prompt token count reflects the post-truncation prompt. Publishing the GGUF
 * maximum therefore hands the harness a window several times larger than
 * reality, so compaction never fires and the oldest part of the prompt — the
 * compiled system prompt carrying persona and memory — is dropped on the floor.
 *
 * `/api/ps` reports `context_length` per *loaded* model, which is the window
 * the engine will actually serve for it. Prefer it whenever it is available.
 */
export function parseOllamaRunningContexts(data: unknown): Map<string, number> {
  const contexts = new Map<string, number>();
  if (!data || typeof data !== "object") return contexts;
  const models = (data as { models?: unknown }).models;
  if (!Array.isArray(models)) return contexts;
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as {
      name?: unknown;
      model?: unknown;
      context_length?: unknown;
    };
    const id = record.name ?? record.model;
    const contextLength = record.context_length;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof contextLength !== "number" || contextLength <= 0) continue;
    contexts.set(id, contextLength);
  }
  return contexts;
}

const OLLAMA_STATUS_TIMEOUT_MS = 2_000;
const OLLAMA_MODEL_LOAD_TIMEOUT_MS = 120_000;

export interface ResolveOllamaServedContextOptions {
  baseURL: string;
  modelId: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

async function fetchOllamaNative<T>(
  fetchImpl: typeof fetch,
  url: string,
  options: {
    apiKey?: string;
    body?: unknown;
    signal?: AbortSignal;
    timeoutMs: number;
    consume(response: Response): Promise<T>;
  },
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.apiKey && options.apiKey !== "not-needed") {
      headers.Authorization = `Bearer ${options.apiKey}`;
    }
    if (options.body !== undefined)
      headers["Content-Type"] = "application/json";
    const response = await fetchImpl(url, {
      method: options.body === undefined ? "GET" : "POST",
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    // Keep the abort deadline active through body consumption and parsing.
    // Fetch resolves at headers, while Ollama's load completes with the body.
    return await options.consume(response);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

/**
 * Resolve turn-time serving truth for one exact Ollama model. Catalog metadata
 * cannot answer this for an unloaded model. A model already loaded by another
 * client can also use that client's `num_ctx`, while our OpenAI-compatible
 * request uses the daemon default. Use Ollama's documented empty generate
 * request to load the selected model with the same default our turn will use,
 * then require `/api/ps` to report that exact identity before dispatch.
 */
export async function resolveOllamaServedContext(
  options: ResolveOllamaServedContextOptions,
): Promise<number> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const modelId = normalizeOllamaModelId(options.modelId);
  const nativeBaseURL = localEndpointNativeBaseURL(options.baseURL);
  const psURL = `${nativeBaseURL}/api/ps`;
  const runningContext = async (): Promise<number | undefined> => {
    const data = await fetchOllamaNative(fetchImpl, psURL, {
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: OLLAMA_STATUS_TIMEOUT_MS,
      consume: (response) => response.json(),
    });
    return parseOllamaRunningContexts(data).get(modelId);
  };

  try {
    await fetchOllamaNative(fetchImpl, `${nativeBaseURL}/api/generate`, {
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      body: { model: modelId, prompt: "", stream: false },
      timeoutMs: OLLAMA_MODEL_LOAD_TIMEOUT_MS,
      consume: (response) => response.text(),
    });
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    throw new Error(
      `Unable to load Ollama model "${modelId}" to determine its served context window. ` +
        `Refusing to send the prompt because Ollama may silently truncate it. ` +
        `Check the Ollama endpoint, model installation, and available memory. (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  try {
    const loadedContext = await runningContext();
    if (loadedContext !== undefined) return loadedContext;
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    throw new Error(
      `Ollama loaded model "${modelId}", but /api/ps could not verify its served context window. ` +
        `Refusing to send the prompt because Ollama may silently truncate it. ` +
        `Check that the endpoint supports /api/ps. (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  throw new Error(
    `Ollama did not report an exact served context window for loaded model "${modelId}" in /api/ps. ` +
      `Refusing to send the prompt because Ollama may silently truncate it. ` +
      `Check the model name and Ollama server logs.`,
  );
}

function parseOllamaShow(
  modelId: string,
  data: unknown,
  runtimeContextLength?: number,
): LocalEndpointModelMetadata {
  if (!data || typeof data !== "object") return { id: modelId };
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
  const architecturalContextLength = architecture
    ? modelInfo?.[`${architecture}.context_length`]
    : undefined;
  // Runtime window wins: it is what the daemon will serve. The GGUF maximum is
  // only a fallback for models that are not currently loaded.
  const contextLength =
    runtimeContextLength ??
    (typeof architecturalContextLength === "number" &&
    architecturalContextLength > 0
      ? architecturalContextLength
      : undefined);
  return {
    id: modelId,
    vision: capabilities.includes("vision"),
    thinking: capabilities.includes("thinking"),
    ...(contextLength !== undefined ? { contextLength } : {}),
  };
}

/**
 * Ollama capability discovery: `/api/tags` lists installed models and
 * `POST /api/show` reports authoritative capabilities per model
 * (`["completion", "vision", "tools", "thinking"]`) plus engine context
 * maximum. The shared provider applies the conservative harness default;
 * model names are never consulted for capabilities.
 */
const ollamaDiscover: LocalEndpointDiscover = async (context) => {
  const tags = await context.fetchJson(`${context.nativeBaseURL}/api/tags`);
  const entries = parseOllamaTags(tags);
  // Loaded-model runtime windows. Best-effort: an endpoint that does not serve
  // /api/ps (or fails it) falls back to GGUF metadata, the previous behavior.
  const runtimeContexts = await context
    .fetchJson(`${context.nativeBaseURL}/api/ps`)
    .then(parseOllamaRunningContexts)
    .catch(() => new Map<string, number>());
  return Promise.all(
    entries.map(async ({ id: modelId, digest }) => {
      // /api/show reads GGUF metadata from disk, which can take seconds for
      // large models. The tag digest identifies the installed blob, so an
      // unchanged digest means the last-known published Model is current. The
      // runtime window is part of the fingerprint because it changes without
      // the blob changing — loading a model, or restarting the daemon with a
      // different OLLAMA_CONTEXT_LENGTH, must republish the Model.
      // `/api/ps` is runtime truth only for the exact loaded model. Another
      // model may have been loaded with a per-request num_ctx, so its value says
      // nothing reliable about this artifact or the daemon default.
      const runtimeContextLength = runtimeContexts.get(modelId);
      const fingerprint = digest
        ? `${digest}:${runtimeContextLength ?? "-"}`
        : undefined;
      const known = context.lastKnown.get(modelId);
      if (
        known &&
        fingerprint &&
        context.metadataFingerprints.get(modelId) === fingerprint
      ) {
        context.nextMetadataFingerprints.set(modelId, fingerprint);
        return known;
      }
      try {
        const show = await context.fetchJson(
          `${context.nativeBaseURL}/api/show`,
          { body: { model: modelId } },
        );
        if (fingerprint) {
          context.nextMetadataFingerprints.set(modelId, fingerprint);
        }
        return context.buildModel(
          parseOllamaShow(modelId, show, runtimeContextLength),
        );
      } catch {
        // Metadata fetch failed for this one model: keep its last-known
        // published Model rather than guessing capabilities. A never-seen
        // model is published text-only until /api/show succeeds.
        return known ?? context.buildModel({ id: modelId });
      }
    }),
  );
};

/**
 * Real dynamic pi-ai Provider for an Ollama endpoint (local daemon or
 * Ollama Cloud — both speak the same native API). See
 * `createLocalEndpointPiProvider` for the shared refresh/auth semantics.
 */
export function createOllamaPiProvider(
  options: OllamaPiProviderOptions,
): Provider<"openai-completions"> {
  const providerId = options.providerId ?? OLLAMA_PI_PROVIDER_ID;
  return createLocalEndpointPiProvider({
    id: providerId,
    name:
      options.name ??
      (providerId === OLLAMA_CLOUD_PI_PROVIDER_ID ? "Ollama Cloud" : "Ollama"),
    baseURL: options.baseURL,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.discoveryTimeoutMs
      ? { discoveryTimeoutMs: options.discoveryTimeoutMs }
      : {}),
    discover: ollamaDiscover,
  });
}
