import { getClient } from "./client";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Minimal model info needed for BYOK model switching
type ModelInfo = {
  handle: string;
  provider_type: string;
};

type CacheEntry = {
  handles: Set<string>;
  modelsByHandle: Map<string, ModelInfo>;
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

  const handles = new Set<string>();
  const modelsByHandle = new Map<string, ModelInfo>();

  for (const m of modelsList) {
    if (m.handle) {
      handles.add(m.handle);
      modelsByHandle.set(m.handle, {
        handle: m.handle,
        provider_type: m.provider_type ?? "unknown",
      });
    }
  }

  return { handles, modelsByHandle, fetchedAt: Date.now() };
}

/**
 * Look up a model's provider_type by handle from the cache.
 * Returns undefined if not found or cache is not populated.
 */
export function getProviderType(handle: string): string | undefined {
  return cache?.modelsByHandle.get(handle)?.provider_type;
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
