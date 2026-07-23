import type { Model, Provider } from "@earendil-works/pi-ai";
import {
  createLocalEndpointPiProvider,
  type LocalEndpointDiscover,
  type LocalEndpointModelMetadata,
  modelIdsFromOpenAICompatibleList,
} from "./pi-local-endpoint-provider";

export const LMSTUDIO_PI_PROVIDER_ID = "lmstudio";

export interface LmStudioPiProviderOptions {
  /** Base URL as configured; `/v1` is appended/stripped as needed. */
  baseURL: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  discoveryTimeoutMs?: number;
  initialModels?: readonly Model<"openai-completions">[];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parseLmStudioModels(data: unknown): LocalEndpointModelMetadata[] {
  if (!data || typeof data !== "object") return [];
  const records = (data as { data?: unknown }).data;
  if (!Array.isArray(records)) return [];
  const models: LocalEndpointModelMetadata[] = [];
  for (const entry of records) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as {
      id?: unknown;
      type?: unknown;
      capabilities?: unknown;
      max_context_length?: unknown;
    };
    if (typeof record.id !== "string" || record.id.length === 0) continue;
    // Embedding models are not chat models; keep them out of /model.
    if (record.type === "embeddings") continue;
    const capabilities = stringArray(record.capabilities);
    const contextLength = record.max_context_length;
    models.push({
      id: record.id,
      vision: record.type === "vlm" || capabilities.includes("vision"),
      thinking: capabilities.includes("reasoning"),
      ...(typeof contextLength === "number" && contextLength > 0
        ? { contextLength }
        : {}),
    });
  }
  return models;
}

/**
 * LM Studio capability discovery: the native REST API
 * (`GET /api/v0/models`) reports each downloaded model's authoritative
 * metadata — `type` (`"vlm"` = vision-language model), an optional
 * `capabilities` array, and `max_context_length`. When the native API is
 * unavailable (older LM Studio), discovery falls back to the
 * OpenAI-compatible `/v1/models` id list and each model keeps its
 * last-known published Model or is published text-only — capabilities are
 * explicitly unknown, never guessed from the model id.
 */
const lmStudioDiscover: LocalEndpointDiscover = async (context) => {
  try {
    const native = await context.fetchJson(
      `${context.nativeBaseURL}/api/v0/models`,
    );
    const models = parseLmStudioModels(native);
    if (models.length > 0) return models.map(context.buildModel);
  } catch {
    // Native metadata API unavailable; fall through to the id-only list.
  }

  const list = await context.fetchJson(`${context.openAIBaseURL}/models`);
  return modelIdsFromOpenAICompatibleList(list).map(
    (modelId) =>
      context.lastKnown.get(modelId) ?? context.buildModel({ id: modelId }),
  );
};

/**
 * Real dynamic pi-ai Provider for an LM Studio server, replacing the Letta
 * connector that fabricated Models from name substrings. See
 * `createLocalEndpointPiProvider` for shared refresh/auth semantics.
 */
export function createLmStudioPiProvider(
  options: LmStudioPiProviderOptions,
): Provider<"openai-completions"> {
  return createLocalEndpointPiProvider({
    id: LMSTUDIO_PI_PROVIDER_ID,
    name: "LM Studio",
    baseURL: options.baseURL,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.discoveryTimeoutMs
      ? { discoveryTimeoutMs: options.discoveryTimeoutMs }
      : {}),
    ...(options.initialModels ? { initialModels: options.initialModels } : {}),
    discover: lmStudioDiscover,
  });
}
