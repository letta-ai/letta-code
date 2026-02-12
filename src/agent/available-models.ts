import { debugWarn } from "../utils/debug";
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

/**
 * Provider response from /v1/providers/ endpoint
 */
type Provider = {
  id: string;
  name: string;
  provider_type: string;
  provider_category?: "base" | "byok" | null;
};

/**
 * Refresh BYOK providers to get the latest models from their APIs.
 * This calls PATCH /v1/providers/{provider_id}/refresh for each BYOK provider.
 * Errors are logged but don't fail the overall refresh (best-effort).
 */
async function refreshByokProviders(): Promise<void> {
  const client = await getClient();

  try {
    // List all providers
    const providers = await client.get<Provider[]>("/v1/providers/");

    // Filter to BYOK providers only
    const byokProviders = providers.filter(
      (p) => p.provider_category === "byok",
    );

    // Refresh each BYOK provider in parallel (best-effort, don't fail on errors)
    await Promise.allSettled(
      byokProviders.map(async (provider) => {
        try {
          await client.patch<Provider>(`/v1/providers/${provider.id}/refresh`);
        } catch (error) {
          // Log but don't throw - refresh is best-effort
          debugWarn(
            "available-models",
            `Failed to refresh provider ${provider.name} (${provider.id}):`,
            error,
          );
        }
      }),
    );
  } catch (error) {
    // If we can't list providers, just log and continue
    // This might happen on self-hosted servers without the providers endpoint
    debugWarn(
      "available-models",
      "Failed to list providers for refresh:",
      error,
    );
  }
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

  // When forceRefresh is true, first refresh BYOK providers to get latest models
  // This matches the behavior in ADE (letta-cloud) where refresh is called before listing models
  if (forceRefresh) {
    await refreshByokProviders();
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
