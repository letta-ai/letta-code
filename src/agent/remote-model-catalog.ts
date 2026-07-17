/**
 * Live model catalog refresh from the cloud catalog endpoint (LET-9792).
 *
 * The bundled models.json snapshot seeds `models` (see
 * `@/agent/model-catalog`) so the CLI always has a working catalog: offline,
 * pre-auth, on self-hosted servers, and on the local backend. On the cloud
 * (API) backend we refresh that catalog in place from
 * GET /v1/models/catalog, which is canon for curated model data — model
 * additions and metadata fixes then reach clients without a CLI release.
 *
 * Failure policy: any fetch/parse problem leaves the current catalog
 * untouched (bundled snapshot or last successful refresh, whichever is
 * newer). A persisted disk cache (~/.letta/cache/model-catalog.json) is
 * loaded at startup so offline restarts keep the freshest known data rather
 * than regressing to the snapshot baked into the release.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type CatalogModel, models } from "@/agent/model-catalog";
import { apiFetch } from "@/backend/api/request";
import { resolveBackendMode } from "@/backend/backend-mode";
import { debugLog, debugWarn } from "@/utils/debug";

const CATALOG_PATH = "/v1/models/catalog";
const REFRESH_TTL_MS = 5 * 60 * 1000; // matches available-models cache TTL

let lastRefreshAt = 0;
let inflight: Promise<boolean> | null = null;
let persistedCacheLoaded = false;

/** Entry shape returned by GET /v1/models/catalog. */
interface RemoteCatalogEntry {
  id: string;
  handle: string;
  label: string;
  brand: string;
  maxContextWindow: number;
  description?: string;
  shortLabel?: string;
  isFeatured?: boolean;
  isDefault?: boolean;
  free?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  config?: Record<string, unknown>;
}

function catalogCachePath(): string {
  const dir =
    process.env.LETTA_MODEL_CATALOG_CACHE_DIR ||
    join(homedir(), ".letta", "cache");
  return join(dir, "model-catalog.json");
}

function hasEntryIdentity(
  entry: unknown,
): entry is { id: string; handle: string; label: string } {
  if (typeof entry !== "object" || entry === null) return false;
  const candidate = entry as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.handle === "string" &&
    typeof candidate.label === "string"
  );
}

function isValidEntry(entry: unknown): entry is RemoteCatalogEntry {
  return hasEntryIdentity(entry);
}

/** Persisted cache rows are already-mapped CatalogModels — no re-mapping. */
function isValidCachedModel(entry: unknown): entry is CatalogModel {
  return hasEntryIdentity(entry);
}

/**
 * Map a remote catalog entry to the bundled models.json entry shape.
 *
 * The endpoint splits models.json's `updateArgs` into typed fields
 * (contextWindow/maxOutputTokens) plus a `config` bag of provider knobs;
 * recombine them so every existing consumer of `model.updateArgs` keeps
 * working unchanged.
 */
export function toCatalogModel(entry: RemoteCatalogEntry): CatalogModel {
  const updateArgs: Record<string, unknown> = { ...(entry.config ?? {}) };
  if (typeof entry.contextWindow === "number") {
    updateArgs.context_window = entry.contextWindow;
  }
  if (typeof entry.maxOutputTokens === "number") {
    updateArgs.max_output_tokens = entry.maxOutputTokens;
  }
  return {
    id: entry.id,
    handle: entry.handle,
    label: entry.label,
    description: entry.description ?? "",
    ...(entry.shortLabel ? { shortLabel: entry.shortLabel } : {}),
    ...(entry.isDefault ? { isDefault: true } : {}),
    ...(entry.isFeatured ? { isFeatured: true } : {}),
    ...(entry.free ? { free: true } : {}),
    ...(Object.keys(updateArgs).length > 0 ? { updateArgs } : {}),
  };
}

/**
 * Replace the live catalog contents in place so existing imports of `models`
 * observe the refreshed data. Refuses obviously-broken payloads (empty, or
 * missing an Auto/default entry) so a bad deploy can't blank the selector.
 */
export function applyCatalogModels(next: CatalogModel[]): boolean {
  if (next.length === 0) {
    return false;
  }
  const hasDefault = next.some((m) => m.isDefault || m.id === "auto");
  if (!hasDefault) {
    return false;
  }
  models.splice(0, models.length, ...next);
  return true;
}

function persistCatalogCache(entries: CatalogModel[]): void {
  try {
    const path = catalogCachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ fetchedAt: Date.now(), models: entries }),
    );
  } catch (error) {
    debugWarn("remote-model-catalog", "failed to persist catalog cache", {
      error: String(error),
    });
  }
}

/**
 * Load the persisted catalog cache (last successful refresh) into the live
 * catalog. Called once at startup, before any network fetch, so offline
 * sessions start from the freshest known data. Best-effort: missing or
 * malformed cache silently keeps the bundled snapshot.
 */
export function loadPersistedModelCatalog(): boolean {
  try {
    const path = catalogCachePath();
    if (!existsSync(path)) {
      return false;
    }
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      models?: unknown;
    };
    if (!Array.isArray(parsed.models)) {
      return false;
    }
    // Cache rows are CatalogModels persisted post-mapping; reject the whole
    // cache on any invalid row (a corrupt cache should never beat the
    // bundled snapshot).
    if (!parsed.models.every(isValidCachedModel)) {
      return false;
    }
    return applyCatalogModels(parsed.models);
  } catch {
    return false;
  }
}

/**
 * Refresh the live model catalog from the cloud endpoint.
 *
 * No-op on non-API backends: self-hosted servers don't run cloud-api, and
 * the local backend gets its catalog from pi-ai. Throttled by TTL and
 * deduped in flight; failures never disturb the current catalog.
 */
export async function refreshModelCatalog(options?: {
  force?: boolean;
}): Promise<boolean> {
  if (resolveBackendMode() !== "api") {
    return false;
  }
  if (!persistedCacheLoaded) {
    persistedCacheLoaded = true;
    loadPersistedModelCatalog();
  }
  const now = Date.now();
  if (!options?.force && now - lastRefreshAt < REFRESH_TTL_MS) {
    return false;
  }
  if (inflight) {
    return inflight;
  }

  const request = (async () => {
    try {
      const response = await apiFetch(CATALOG_PATH);
      if (!response.ok) {
        debugLog("remote-model-catalog", "catalog fetch failed", {
          status: response.status,
        });
        return false;
      }
      const payload = (await response.json()) as { models?: unknown };
      if (!Array.isArray(payload.models)) {
        return false;
      }
      const valid = payload.models.filter(isValidEntry).map(toCatalogModel);
      if (valid.length !== payload.models.length) {
        debugWarn("remote-model-catalog", "catalog payload had invalid rows", {
          total: payload.models.length,
          valid: valid.length,
        });
      }
      if (!applyCatalogModels(valid)) {
        return false;
      }
      lastRefreshAt = Date.now();
      persistCatalogCache(valid);
      debugLog("remote-model-catalog", "catalog refreshed", {
        entries: valid.length,
      });
      return true;
    } catch (error) {
      debugLog("remote-model-catalog", "catalog fetch errored", {
        error: String(error),
      });
      return false;
    } finally {
      inflight = null;
    }
  })();
  inflight = request;
  return request;
}

/** Fire-and-forget catalog warmup (startup path). */
export function prefetchModelCatalog(): void {
  void refreshModelCatalog().catch(() => {
    // Failures already logged inside refreshModelCatalog.
  });
}

/** Test hook: reset throttle/inflight state. */
export function __testResetRemoteModelCatalog(): void {
  lastRefreshAt = 0;
  inflight = null;
  persistedCacheLoaded = true; // tests exercise fetch/apply, not disk cache
}
