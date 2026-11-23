import type { Provider } from "@earendil-works/pi-ai";
import {
  createLocalEndpointPiProvider,
  type LocalEndpointDiscover,
  type LocalEndpointModelMetadata,
  modelIdsFromOpenAICompatibleList,
} from "./pi-local-endpoint-provider";

export const LMSTUDIO_PI_PROVIDER_ID = "lmstudio";

export interface LmStudioPiProviderOptions {
  baseURL: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  discoveryTimeoutMs?: number;
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
      state?: unknown;
      capabilities?: unknown;
      loaded_context_length?: unknown;
      max_context_length?: unknown;
    };
    if (typeof record.id !== "string" || record.id.length === 0) continue;
    if (record.type === "embeddings") continue;
    const capabilities = stringArray(record.capabilities);
    const loadedContextLength =
      record.state === "loaded" &&
      typeof record.loaded_context_length === "number" &&
      record.loaded_context_length > 0
        ? record.loaded_context_length
        : undefined;
    const maxContextLength =
      typeof record.max_context_length === "number" &&
      record.max_context_length > 0
        ? record.max_context_length
        : undefined;
    const contextLength = loadedContextLength ?? maxContextLength;
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

const lmStudioDiscover: LocalEndpointDiscover = async (context) => {
  try {
    const native = await context.fetchJson(
      `${context.nativeBaseURL}/api/v0/models`,
    );
    const models = parseLmStudioModels(native);
    if (models.length > 0) return models.map(context.buildModel);
  } catch {}

  const list = await context.fetchJson(`${context.openAIBaseURL}/models`);
  return modelIdsFromOpenAICompatibleList(list).map(
    (modelId) =>
      context.lastKnown.get(modelId) ?? context.buildModel({ id: modelId }),
  );
};

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
    discover: lmStudioDiscover,
  });
}
