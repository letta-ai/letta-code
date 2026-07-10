import { getBackend } from "@/backend";
import { refreshByokProviders } from "@/backend/api/providers";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

type CacheEntry = {
  handles: Set<string>;
  contextWindows: Map<string, number>; // handle -> max_context_window
  providerTypes: Map<string, string>; // handle -> provider_type
  fetchedAt: number;
};

let cache: CacheEntry | null = null;
let inflight: Promise<CacheEntry> | null = null;
// Bumped on every cache clear so an in-flight fetch that started BEFORE the
// clear (e.g. before a provider connect) can never commit its now-stale
// result into the cache after the clear.
let generation = 0;

function isFresh(now = Date.now()) {
  return cache !== null && now - cache.fetchedAt < CACHE_TTL_MS;
}

export type AvailableModelHandlesResult = {
  handles: Set<string>;
  providerTypes: Map<string, string>;
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

/**
 * Return cached model handles if available.
 * Used by UI components to bootstrap from cache without showing a loading flash.
 */
export function getCachedModelHandles(): Set<string> | null {
  if (!cache) {
    return null;
  }
  return new Set(cache.handles);
}

/**
 * Return cached provider_type metadata by handle if available.
 * Used to carry backend model-catalog provider identity through selection
 * without re-listing models during model update mutations.
 */
export function getCachedModelProviderTypes(): Map<string, string> | null {
  if (!cache) {
    return null;
  }
  return new Map(cache.providerTypes);
}

async function fetchFromNetwork(): Promise<CacheEntry> {
  const modelsList = await getBackend().listModels();
  const handles = new Set(
    modelsList.map((m) => m.handle).filter((h): h is string => !!h),
  );
  // Build context window map from API response
  const contextWindows = new Map<string, number>();
  const providerTypes = new Map<string, string>();
  for (const model of modelsList) {
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
  }
  return { handles, contextWindows, providerTypes, fetchedAt: Date.now() };
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
      source: "cache",
      fetchedAt: cache.fetchedAt,
    };
  }

  if (!forceRefresh && inflight) {
    const entry = await inflight;
    return {
      handles: entry.handles,
      providerTypes: entry.providerTypes,
      source: "network",
      fetchedAt: entry.fetchedAt,
    };
  }

  // When forceRefresh is true, first refresh BYOK providers to get latest models
  // This matches the behavior in ADE (letta-cloud) where refresh is called before listing models
  const backend = getBackend();
  if (forceRefresh && backend.capabilities.byokProviderRefresh) {
    await refreshByokProviders();
  }

  const requestGeneration = generation;
  const request: Promise<CacheEntry> = fetchFromNetwork()
    .then((entry) => {
      // Only commit if the cache wasn't cleared while we were fetching;
      // otherwise this result predates a provider mutation and is stale.
      if (generation === requestGeneration) {
        cache = entry;
      }
      return entry;
    })
    .finally(() => {
      // A forced or post-clear fetch may have replaced `inflight` already —
      // never null out someone else's request.
      if (inflight === request) {
        inflight = null;
      }
    });
  inflight = request;

  const entry = await request;
  return {
    handles: entry.handles,
    providerTypes: entry.providerTypes,
    source: "network",
    fetchedAt: entry.fetchedAt,
  };
}

/**
 * Best-effort prefetch to warm the cache (no throw).
 * This is intentionally fire-and-forget.
 */
export function prefetchAvailableModelHandles(): void {
  void getAvailableModelHandles().catch(() => {
    // Ignore failures; UI will handle errors on-demand.
  });
}

/**
 * Get the max_context_window for a model handle from the API.
 * Ensures the cache is populated before reading.
 * Returns undefined if handle not found in the API response.
 */
export async function getModelContextWindow(
  handle: string,
): Promise<number | undefined> {
  if (!cache) {
    await getAvailableModelHandles();
  }
  return cache?.contextWindows.get(handle);
}

/**
 * Get provider_type metadata for a model handle from the cached API model list.
 * Ensures the shared cache is populated before reading.
 */
export async function getModelProviderType(
  handle: string,
): Promise<string | undefined> {
  if (!cache) {
    await getAvailableModelHandles();
  }
  return cache?.providerTypes.get(handle);
}
