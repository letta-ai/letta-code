import { getClient } from "./client";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type ApiModel = {
  handle: string;
  name: string;
  display_name: string;
  provider_type: string;
  provider_name: string;
  provider_category: string;
  context_window?: number;
};

type CacheEntry = {
  handles: Set<string>;
  models: ApiModel[];
  fetchedAt: number;
};

let cache: CacheEntry | null = null;
let inflight: Promise<CacheEntry> | null = null;

function isFresh(now = Date.now()) {
  return cache !== null && now - cache.fetchedAt < CACHE_TTL_MS;
}

export type AvailableModelHandlesResult = {
  handles: Set<string>;
  models: ApiModel[];
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
  const models: ApiModel[] = modelsList
    .filter((m): m is typeof m & { handle: string } => !!m.handle)
    .map((m) => ({
      handle: m.handle,
      name: m.name ?? m.handle,
      display_name: m.display_name ?? m.name ?? m.handle,
      provider_type: m.provider_type ?? "unknown",
      provider_name: m.provider_name ?? "unknown",
      provider_category: m.provider_category ?? "unknown",
      context_window: m.context_window,
    }));
  return { handles, models, fetchedAt: Date.now() };
}

/**
 * Look up a model by handle from the cache.
 * Returns undefined if the model is not found or cache is not populated.
 */
export function getModelByHandle(handle: string): ApiModel | undefined {
  if (!cache) return undefined;
  return cache.models.find((m) => m.handle === handle);
}

export async function getAvailableModelHandles(options?: {
  forceRefresh?: boolean;
}): Promise<AvailableModelHandlesResult> {
  const forceRefresh = options?.forceRefresh === true;
  const now = Date.now();

  if (!forceRefresh && isFresh(now) && cache) {
    return {
      handles: cache.handles,
      models: cache.models,
      source: "cache",
      fetchedAt: cache.fetchedAt,
    };
  }

  if (!forceRefresh && inflight) {
    const entry = await inflight;
    return {
      handles: entry.handles,
      models: entry.models,
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
    models: entry.models,
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
