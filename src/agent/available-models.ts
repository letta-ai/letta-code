import { getBackend } from "@/backend";
import { refreshByokProviders } from "@/backend/api/providers";
import { isOpenAICompatibleProxyEndpoint } from "@/utils/openai-endpoint";
import type { ModelReasoningEffort } from "./model";

const CACHE_TTL_MS = 5 * 60 * 1000;

export type AvailableModel = {
  handle: string;
  label: string;
  supportsStructuredOutputs?: boolean;
  maxContextWindow?: number;
  maxOutputTokens?: number;
  providerType?: string;
  providerCategory?: string;
  modelEndpoint?: string;
  modelId?: string;
  openAICompatibleProxy?: boolean;
  reasoningLevels?: string[];
};

export type ReasoningCapabilities = {
  supported_efforts?: ModelReasoningEffort[] | null;
  mandatory?: boolean;
};

type CacheEntry = {
  handles: Set<string>;
  contextWindows: Map<string, number>;
  providerTypes: Map<string, string>;
  reasoningCapabilities: Map<string, ReasoningCapabilities>;
  openAICompatibleProxyHandles: Set<string>;
  models: AvailableModel[];
  fetchedAt: number;
};

let cache: CacheEntry | null = null;
let inflight: Promise<CacheEntry> | null = null;
let generation = 0;

function isFresh(now = Date.now()) {
  return cache !== null && now - cache.fetchedAt < CACHE_TTL_MS;
}

export type AvailableModelHandlesResult = {
  handles: Set<string>;
  providerTypes: Map<string, string>;
  openAICompatibleProxyHandles: Set<string>;
  models: AvailableModel[];
  source: "cache" | "network";
  fetchedAt: number;
};

export function clearAvailableModelsCache() {
  cache = null;
  inflight = null;
  generation++;
}

export function getAvailableModelsCacheInfo(): {
  hasCache: boolean;
  isFresh: boolean;
  fetchedAt: number | null;
  ageMs: number | null;
  ttlMs: number;
} {
  const now = Date.now();
  return {
    hasCache: cache !== null,
    isFresh: isFresh(now),
    fetchedAt: cache?.fetchedAt ?? null,
    ageMs: cache ? now - cache.fetchedAt : null,
    ttlMs: CACHE_TTL_MS,
  };
}

export function getCachedModelHandles(): Set<string> | null {
  if (!cache) {
    return null;
  }
  return new Set(cache.handles);
}

export function getCachedModelProviderTypes(): Map<string, string> | null {
  if (!cache) {
    return null;
  }
  return new Map(cache.providerTypes);
}

export function getCachedModelReasoningCapabilities(): Map<
  string,
  ReasoningCapabilities
> | null {
  if (!cache) {
    return null;
  }
  return new Map(cache.reasoningCapabilities);
}

export function getCachedOpenAICompatibleProxyHandles(): Set<string> | null {
  return cache ? new Set(cache.openAICompatibleProxyHandles) : null;
}

export function getCachedAvailableModels(): AvailableModel[] | null {
  return cache?.models.map((model) => ({ ...model })) ?? null;
}

async function fetchFromNetwork(): Promise<CacheEntry> {
  const modelsList = await getBackend().listModels();
  const handles = new Set(
    modelsList.map((m) => m.handle).filter((h): h is string => !!h),
  );
  const contextWindows = new Map<string, number>();
  const providerTypes = new Map<string, string>();
  const reasoningCapabilities = new Map<string, ReasoningCapabilities>();
  const openAICompatibleProxyHandles = new Set<string>();
  const modelsByHandle = new Map<string, AvailableModel>();
  for (const model of modelsList) {
    const modelRecord = model as unknown as Record<string, unknown>;
    if (model.handle && model.max_context_window) {
      contextWindows.set(model.handle, model.max_context_window);
    }
    const providerType =
      typeof model.provider_type === "string"
        ? model.provider_type
        : typeof model.model_endpoint_type === "string"
          ? model.model_endpoint_type
          : undefined;
    if (model.handle && providerType) {
      providerTypes.set(model.handle, providerType);
    }
    const providerCategory =
      typeof modelRecord.provider_category === "string"
        ? modelRecord.provider_category
        : undefined;
    const modelEndpoint =
      typeof modelRecord.model_endpoint === "string"
        ? modelRecord.model_endpoint
        : undefined;
    const isOpenAICompatibleProxy =
      providerCategory === "byok" &&
      providerType === "openai" &&
      isOpenAICompatibleProxyEndpoint(modelEndpoint);
    if (model.handle && isOpenAICompatibleProxy) {
      openAICompatibleProxyHandles.add(model.handle);
    }
    const capabilities = parseReasoningCapabilities(
      modelRecord.reasoning_capabilities,
    );
    if (model.handle && capabilities) {
      reasoningCapabilities.set(model.handle, capabilities);
    }
    if (model.handle) {
      const label =
        (typeof model.display_name === "string" && model.display_name) ||
        (typeof model.name === "string" && model.name) ||
        (typeof model.model === "string" && model.model) ||
        model.handle;
      const modelId =
        typeof modelRecord.model_id === "string"
          ? modelRecord.model_id
          : undefined;
      const reasoningLevels = Array.isArray(modelRecord.reasoning_levels)
        ? modelRecord.reasoning_levels.filter(
            (level): level is string => typeof level === "string",
          )
        : undefined;
      const availableModel = {
        handle: model.handle,
        label,
        ...(typeof modelRecord.supports_structured_outputs === "boolean"
          ? {
              supportsStructuredOutputs:
                modelRecord.supports_structured_outputs,
            }
          : {}),
        ...(typeof model.max_context_window === "number"
          ? { maxContextWindow: model.max_context_window }
          : {}),
        ...(typeof model.max_tokens === "number"
          ? { maxOutputTokens: model.max_tokens }
          : {}),
        ...(providerType ? { providerType } : {}),
        ...(providerCategory ? { providerCategory } : {}),
        ...(modelEndpoint ? { modelEndpoint } : {}),
        ...(modelId ? { modelId } : {}),
        ...(isOpenAICompatibleProxy ? { openAICompatibleProxy: true } : {}),
        ...(reasoningLevels ? { reasoningLevels } : {}),
      };
      if (!modelsByHandle.has(model.handle)) {
        modelsByHandle.set(model.handle, availableModel);
      }
    }
  }
  return {
    handles,
    contextWindows,
    providerTypes,
    reasoningCapabilities,
    openAICompatibleProxyHandles,
    models: [...modelsByHandle.values()],
    fetchedAt: Date.now(),
  };
}

function parseReasoningCapabilities(
  value: unknown,
): ReasoningCapabilities | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const supported = record.supported_efforts;
  const supported_efforts =
    supported === null
      ? null
      : Array.isArray(supported)
        ? supported.filter(isModelReasoningEffort)
        : undefined;
  return {
    ...(supported_efforts !== undefined ? { supported_efforts } : {}),
    ...(typeof record.mandatory === "boolean"
      ? { mandatory: record.mandatory }
      : {}),
  };
}

function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

export async function getAvailableModelHandles(options?: {
  forceRefresh?: boolean;
}): Promise<AvailableModelHandlesResult> {
  const forceRefresh = options?.forceRefresh === true;
  const now = Date.now();

  if (!forceRefresh && isFresh(now) && cache) {
    return {
      handles: cache.handles,
      providerTypes: cache.providerTypes,
      openAICompatibleProxyHandles: cache.openAICompatibleProxyHandles,
      models: cache.models,
      source: "cache",
      fetchedAt: cache.fetchedAt,
    };
  }

  if (!forceRefresh && inflight) {
    const entry = await inflight;
    return {
      handles: entry.handles,
      providerTypes: entry.providerTypes,
      openAICompatibleProxyHandles: entry.openAICompatibleProxyHandles,
      models: entry.models,
      source: "network",
      fetchedAt: entry.fetchedAt,
    };
  }

  const backend = getBackend();
  if (forceRefresh && backend.capabilities.byokProviderRefresh) {
    await refreshByokProviders();
  }

  const requestGeneration = generation;
  const request: Promise<CacheEntry> = fetchFromNetwork()
    .then((entry) => {
      if (generation === requestGeneration) {
        cache = entry;
      }
      return entry;
    })
    .finally(() => {
      if (inflight === request) {
        inflight = null;
      }
    });
  inflight = request;

  const entry = await request;
  return {
    handles: entry.handles,
    providerTypes: entry.providerTypes,
    openAICompatibleProxyHandles: entry.openAICompatibleProxyHandles,
    models: entry.models,
    source: "network",
    fetchedAt: entry.fetchedAt,
  };
}

export function prefetchAvailableModelHandles(): void {
  void getAvailableModelHandles().catch(() => {});
}

export async function getModelContextWindow(
  handle: string,
): Promise<number | undefined> {
  if (!cache) {
    await getAvailableModelHandles();
  }
  return cache?.contextWindows.get(handle);
}

export async function getModelProviderType(
  handle: string,
): Promise<string | undefined> {
  const result = await getAvailableModelHandles();
  return result.providerTypes.get(handle);
}
