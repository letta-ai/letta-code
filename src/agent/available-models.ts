import { getClient } from "./client";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

type CacheEntry = {
  handles: Set<string>;
  contextWindows: Map<string, number>; // handle -> max_context_window
  fetchedAt: number;
};

let cache: CacheEntry | null = null;
let inflight: Promise<CacheEntry> | null = null;

function isFresh(now = Date.now()) {
  return cache !== null && now - cache.fetchedAt < CACHE_TTL_MS;
}

export type AvailableModelHandlesResult = {
  handles: Set<string>;
  source: "cache" | "network";
  fetchedAt: number;
};

export function clearAvailableModelsCache() {
  cache = null;
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

async function fetchFromNetwork(): Promise<CacheEntry> {
  const client = await getClient();
  const modelsList = await client.models.list();
  const handles = new Set(
    modelsList.map((m) => m.handle).filter((h): h is string => !!h),
  );
  // Build context window map from API response
  const contextWindows = new Map<string, number>();
  for (const model of modelsList) {
    if (model.handle && model.max_context_window) {
      contextWindows.set(model.handle, model.max_context_window);
    }
  }
  return { handles, contextWindows, fetchedAt: Date.now() };
}

export async function getAvailableModelHandles(options?: {
  forceRefresh?: boolean;
}): Promise<AvailableModelHandlesResult> {
  const forceRefresh = options?.forceRefresh === true;
  const now = Date.now();

  if (!forceRefresh && isFresh(now) && cache) {
    return {
      handles: cache.handles,
      source: "cache",
      fetchedAt: cache.fetchedAt,
    };
  }

  if (!forceRefresh && inflight) {
    const entry = await inflight;
    return {
      handles: entry.handles,
      source: "network",
      fetchedAt: entry.fetchedAt,
    };
  }

  inflight = fetchFromNetwork()
    .then((entry) => {
      cache = entry;
      return entry;
    })
    .finally(() => {
      inflight = null;
    });

  const entry = await inflight;
  return {
    handles: entry.handles,
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
 * Get the max_context_window for a model handle from the cached API response.
 * Returns undefined if not cached or handle not found.
 */
export function getModelContextWindow(handle: string): number | undefined {
  return cache?.contextWindows.get(handle);
}
