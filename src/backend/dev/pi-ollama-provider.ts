import type { Model, Provider } from "@earendil-works/pi-ai";
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
  initialModels?: readonly Model<"openai-completions">[];
  /** Defaults to the local Ollama provider; Ollama Cloud reuses this factory. */
  providerId?: string;
  name?: string;
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
  const modelIds = parseOllamaTags(tags);
  return Promise.all(
    modelIds.map(async (modelId) => {
      try {
        const show = await context.fetchJson(
          `${context.nativeBaseURL}/api/show`,
          { body: { model: modelId } },
        );
        return context.buildModel(parseOllamaShow(modelId, show));
      } catch {
        // Metadata fetch failed for this one model: keep its last-known
        // published Model rather than guessing capabilities. A never-seen
        // model is published text-only until /api/show succeeds.
        return (
          context.lastKnown.get(modelId) ?? context.buildModel({ id: modelId })
        );
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
    ...(options.initialModels ? { initialModels: options.initialModels } : {}),
    discover: ollamaDiscover,
  });
}
