import type { Provider } from "@earendil-works/pi-ai";
import {
  createLocalEndpointPiProvider,
  type LocalEndpointDiscover,
  type LocalEndpointModelMetadata,
} from "./pi-local-endpoint-provider";

export const OLLAMA_PI_PROVIDER_ID = "ollama";
export const OLLAMA_CLOUD_PI_PROVIDER_ID = "ollama-cloud";

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

function parseOllamaShow(
  modelId: string,
  data: unknown,
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
  const contextLength = architecture
    ? modelInfo?.[`${architecture}.context_length`]
    : undefined;
  return {
    id: modelId,
    vision: capabilities.includes("vision"),
    thinking: capabilities.includes("thinking"),
    ...(typeof contextLength === "number" && contextLength > 0
      ? { contextLength }
      : {}),
  };
}

/**
 * Ollama capability discovery: `/api/tags` lists installed models and
 * `POST /api/show` reports authoritative capabilities per model
 * (`["completion", "vision", "tools", "thinking"]`) plus engine context
 * length. Model names are never consulted for capabilities.
 */
const ollamaDiscover: LocalEndpointDiscover = async (context) => {
  const tags = await context.fetchJson(`${context.nativeBaseURL}/api/tags`);
  const entries = parseOllamaTags(tags);
  return Promise.all(
    entries.map(async ({ id: modelId, digest }) => {
      // /api/show reads GGUF metadata from disk, which can take seconds for
      // large models. The tag digest identifies the installed blob, so an
      // unchanged digest means the last-known published Model is current.
      const known = context.lastKnown.get(modelId);
      if (
        known &&
        digest &&
        context.metadataFingerprints.get(modelId) === digest
      ) {
        context.nextMetadataFingerprints.set(modelId, digest);
        return known;
      }
      try {
        const show = await context.fetchJson(
          `${context.nativeBaseURL}/api/show`,
          { body: { model: modelId } },
        );
        if (digest) context.nextMetadataFingerprints.set(modelId, digest);
        return context.buildModel(parseOllamaShow(modelId, show));
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
