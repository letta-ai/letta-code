/**
 * Live model catalog refresh from the cloud catalog endpoint (LET-9792).
 *
 * The bundled models.json snapshot seeds `models` (see
 * `@/agent/model-catalog`) so the CLI always has a working catalog: offline,
 * pre-auth, on self-hosted servers, and on the local backend. On API
 * backends we attempt to refresh that catalog in place from
 * GET /v1/models/catalog, which is canon for curated model data — model
 * additions and metadata fixes then reach clients without a CLI release.
 *
 * Failure policy: any fetch/parse problem leaves the current catalog
 * untouched (bundled snapshot or last successful refresh, whichever is
 * newer). A persisted disk cache (~/.letta/cache/model-catalog.json) is
 * loaded at startup so offline restarts keep the freshest known data rather
 * than regressing to the snapshot baked into the release.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type CatalogModel, models } from "@/agent/model-catalog";
import { apiFetch, getApiRequestConfig } from "@/backend/api/request";
import { resolveBackendMode } from "@/backend/backend-mode";
import { debugLog, debugWarn } from "@/utils/debug";

const CATALOG_PATH = "/v1/models/catalog";
const REFRESH_TTL_MS = 5 * 60 * 1000; // matches available-models cache TTL
const REQUEST_TIMEOUT_MS = 5_000;
const CACHE_SCHEMA_VERSION = 1;

let lastRefreshAt = 0;
let activeCatalogSource: string | null = null;
let sourceGeneration = 0;
let persistedCacheSource: string | null = null;
let inflight: {
  source: string;
  promise: Promise<boolean>;
  token: symbol;
} | null = null;

function cloneCatalogModels(entries: readonly CatalogModel[]): CatalogModel[] {
  return entries.map((entry) => ({
    ...entry,
    ...(entry.updateArgs ? { updateArgs: { ...entry.updateArgs } } : {}),
  }));
}

const bundledCatalog = cloneCatalogModels(models);
const bundledCatalogFingerprint = createHash("sha256")
  .update(JSON.stringify(bundledCatalog))
  .digest("hex");

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

function normalizeCatalogSource(source: string): string {
  try {
    const url = new URL(source);
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return source.trim().replace(/\/+$/, "");
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isOptionalPositiveFiniteNumber(
  value: unknown,
): value is number | undefined {
  return value === undefined || isPositiveFiniteNumber(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasEntryIdentity(
  entry: unknown,
): entry is { id: string; handle: string; label: string } {
  if (!isRecord(entry)) return false;
  return (
    isNonEmptyString(entry.id) &&
    isNonEmptyString(entry.handle) &&
    isNonEmptyString(entry.label)
  );
}

function isValidEntry(entry: unknown): entry is RemoteCatalogEntry {
  if (!hasEntryIdentity(entry)) return false;
  const candidate = entry as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.brand) &&
    isPositiveFiniteNumber(candidate.maxContextWindow) &&
    isOptionalString(candidate.description) &&
    isOptionalString(candidate.shortLabel) &&
    isOptionalBoolean(candidate.isFeatured) &&
    isOptionalBoolean(candidate.isDefault) &&
    isOptionalBoolean(candidate.free) &&
    isOptionalPositiveFiniteNumber(candidate.contextWindow) &&
    isOptionalPositiveFiniteNumber(candidate.maxOutputTokens) &&
    (candidate.config === undefined || isRecord(candidate.config))
  );
}

/** Persisted cache rows are already-mapped CatalogModels — no re-mapping. */
function isValidCachedModel(entry: unknown): entry is CatalogModel {
  if (!hasEntryIdentity(entry)) return false;
  const candidate = entry as Record<string, unknown>;
  return (
    typeof candidate.description === "string" &&
    isOptionalString(candidate.shortLabel) &&
    isOptionalBoolean(candidate.isDefault) &&
    isOptionalBoolean(candidate.isFeatured) &&
    isOptionalBoolean(candidate.free) &&
    (candidate.updateArgs === undefined || isRecord(candidate.updateArgs))
  );
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
  if (
    next.length === 0 ||
    !next.every(isValidCachedModel) ||
    new Set(next.map((model) => model.id)).size !== next.length
  ) {
    return false;
  }
  const defaults = next.filter(
    (model) => model.isDefault || model.id === "auto",
  );
  if (defaults.length !== 1) {
    return false;
  }
  models.splice(0, models.length, ...next);
  return true;
}

function persistCatalogCache(entries: CatalogModel[], source: string): void {
  try {
    const path = catalogCachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: CACHE_SCHEMA_VERSION,
        source,
        bundledCatalogFingerprint,
        fetchedAt: Date.now(),
        models: entries,
      }),
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
export function loadPersistedModelCatalog(source: string): boolean {
  try {
    const path = catalogCachePath();
    if (!existsSync(path)) {
      return false;
    }
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      schemaVersion?: unknown;
      source?: unknown;
      bundledCatalogFingerprint?: unknown;
      models?: unknown;
    };
    if (
      parsed.schemaVersion !== CACHE_SCHEMA_VERSION ||
      parsed.source !== normalizeCatalogSource(source) ||
      parsed.bundledCatalogFingerprint !== bundledCatalogFingerprint ||
      !Array.isArray(parsed.models)
    ) {
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

function activateCatalogSource(source: string | null): number {
  if (activeCatalogSource === source) {
    return sourceGeneration;
  }
  activeCatalogSource = source;
  sourceGeneration += 1;
  lastRefreshAt = 0;
  persistedCacheSource = null;
  models.splice(0, models.length, ...cloneCatalogModels(bundledCatalog));
  return sourceGeneration;
}

/**
 * Refresh the live model catalog from the cloud endpoint.
 *
 * No-op on the local backend, which gets its catalog from pi-ai. API servers
 * without the cloud catalog endpoint fall back to the bundled catalog.
 * Throttled by TTL and deduped in flight; failures never disturb the active
 * source's current catalog.
 */
export async function refreshModelCatalog(options?: {
  force?: boolean;
}): Promise<boolean> {
  if (resolveBackendMode() !== "api") {
    activateCatalogSource(null);
    return false;
  }

  const requestConfig = await getApiRequestConfig();
  const source = normalizeCatalogSource(requestConfig.baseUrl);
  const requestGeneration = activateCatalogSource(source);
  if (persistedCacheSource !== source) {
    persistedCacheSource = source;
    loadPersistedModelCatalog(source);
  }
  const now = Date.now();
  if (!options?.force && now - lastRefreshAt < REFRESH_TTL_MS) {
    return false;
  }
  if (inflight?.source === source) {
    return inflight.promise;
  }

  const requestToken = Symbol("model-catalog-refresh");
  const request = (async () => {
    try {
      const response = await apiFetch(CATALOG_PATH, {
        baseUrl: requestConfig.baseUrl,
        apiKey: requestConfig.apiKey,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
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
      if (!payload.models.every(isValidEntry)) {
        debugWarn("remote-model-catalog", "catalog payload had invalid rows", {
          total: payload.models.length,
          valid: payload.models.filter(isValidEntry).length,
        });
        return false;
      }
      const next = payload.models.map(toCatalogModel);
      if (
        activeCatalogSource !== source ||
        sourceGeneration !== requestGeneration ||
        !applyCatalogModels(next)
      ) {
        return false;
      }
      lastRefreshAt = Date.now();
      persistCatalogCache(next, source);
      debugLog("remote-model-catalog", "catalog refreshed", {
        entries: next.length,
      });
      return true;
    } catch (error) {
      debugLog("remote-model-catalog", "catalog fetch errored", {
        error: String(error),
      });
      return false;
    } finally {
      if (inflight?.token === requestToken) {
        inflight = null;
      }
    }
  })();
  inflight = { source, promise: request, token: requestToken };
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
  activeCatalogSource = null;
  sourceGeneration += 1;
  persistedCacheSource = null;
  models.splice(0, models.length, ...cloneCatalogModels(bundledCatalog));
}
