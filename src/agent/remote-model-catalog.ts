/**
 * Live model catalog refresh from the cloud catalog endpoint (LET-9792).
 *
 * API backends load curated presets from GET /v1/models/catalog. Local
 * backends project their pi-ai inventory into the same CatalogModel shape.
 *
 * API catalogs are persisted at ~/.letta/cache/model-catalog.json so a
 * temporary endpoint failure keeps the last successful catalog. There is no
 * bundled catalog: cloud is canonical for API mode and pi-ai is canonical for
 * local mode.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AvailableModel,
  getAvailableModelHandles,
} from "@/agent/available-models";
import { type CatalogModel, models } from "@/agent/model-catalog";
import { apiFetch, getApiRequestConfig } from "@/backend/api/request";
import { resolveBackendMode } from "@/backend/backend-mode";
import { debugLog, debugWarn } from "@/utils/debug";

const CATALOG_PATH = "/v1/models/catalog";
const REFRESH_TTL_MS = 5 * 60 * 1000; // matches available-models cache TTL
const REQUEST_TIMEOUT_MS = 5_000;
const CACHE_SCHEMA_VERSION = 1;
const LOCAL_CATALOG_SOURCE = "local:pi-ai";

let lastRefreshAt = 0;
let activeCatalogSource: string | null = null;
let sourceGeneration = 0;
let persistedCacheSource: string | null = null;
let inflight: {
  source: string;
  promise: Promise<boolean>;
  token: symbol;
} | null = null;

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
 * Map a remote catalog entry to the shared runtime catalog shape.
 *
 * The endpoint splits the runtime catalog's `updateArgs` into typed fields
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
 * observe refreshed data. Refuses empty or malformed payloads; cloud callers
 * additionally require exactly one Auto/default entry.
 */
export function applyCatalogModels(
  next: CatalogModel[],
  options: { requireManagedDefault?: boolean } = {},
): boolean {
  if (
    next.length === 0 ||
    !next.every(isValidCachedModel) ||
    new Set(next.map((model) => model.id)).size !== next.length
  ) {
    return false;
  }
  if (options.requireManagedDefault !== false) {
    const defaults = next.filter(
      (model) => model.isDefault || model.id === "auto",
    );
    if (defaults.length !== 1) {
      return false;
    }
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
 * catalog. Called once at startup, before any network fetch, so temporary
 * endpoint failures keep the freshest known cloud data.
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
      models?: unknown;
    };
    if (
      parsed.schemaVersion !== CACHE_SCHEMA_VERSION ||
      parsed.source !== normalizeCatalogSource(source) ||
      !Array.isArray(parsed.models)
    ) {
      return false;
    }
    // Cache rows are CatalogModels persisted post-mapping; reject the whole
    // cache on any invalid row.
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
  models.splice(0, models.length);
  return sourceGeneration;
}

function modelIdFromHandle(handle: string): string {
  const slashIndex = handle.indexOf("/");
  return slashIndex === -1 ? handle : handle.slice(slashIndex + 1);
}

function uniqueLocalModelIds(
  entries: readonly AvailableModel[],
): Map<string, string> {
  const handlesById = new Map<string, Set<string>>();
  for (const entry of entries) {
    const id = entry.modelId ?? modelIdFromHandle(entry.handle);
    const handles = handlesById.get(id) ?? new Set<string>();
    handles.add(entry.handle);
    handlesById.set(id, handles);
  }
  return new Map(
    entries.map((entry) => {
      const id = entry.modelId ?? modelIdFromHandle(entry.handle);
      return [
        entry.handle,
        handlesById.get(id)?.size === 1 ? id : entry.handle,
      ];
    }),
  );
}

function reasoningEffortForThinkingLevel(level: string): string {
  return level === "off" ? "none" : level;
}

/** Project local pi-ai inventory into the shared runtime catalog shape. */
export function toLocalCatalogModels(
  entries: readonly AvailableModel[],
): CatalogModel[] {
  const ids = uniqueLocalModelIds(entries);
  const catalog: CatalogModel[] = [];
  for (const entry of entries) {
    const baseId = ids.get(entry.handle) ?? entry.handle;
    const levels = entry.reasoningLevels ?? [];
    const variants = levels.length > 1 ? levels : [undefined];
    for (const level of variants) {
      const effort = level ? reasoningEffortForThinkingLevel(level) : undefined;
      const updateArgs: Record<string, unknown> = {
        ...(entry.providerType ? { provider_type: entry.providerType } : {}),
        ...(typeof entry.maxContextWindow === "number"
          ? { context_window: entry.maxContextWindow }
          : {}),
        ...(typeof entry.maxOutputTokens === "number"
          ? { max_output_tokens: entry.maxOutputTokens }
          : {}),
        ...(effort
          ? {
              reasoning_effort: effort,
              enable_reasoner: effort !== "none",
            }
          : {}),
        parallel_tool_calls: true,
      };
      catalog.push({
        id: effort ? `${baseId}-${effort}` : baseId,
        handle: entry.handle,
        label: entry.label,
        description: "",
        ...(Object.keys(updateArgs).length > 0 ? { updateArgs } : {}),
      });
    }
  }
  return catalog;
}

async function refreshLocalModelCatalog(options?: {
  force?: boolean;
}): Promise<boolean> {
  const sourceChanged = activeCatalogSource !== LOCAL_CATALOG_SOURCE;
  activateCatalogSource(LOCAL_CATALOG_SOURCE);
  try {
    const available = await getAvailableModelHandles(
      options?.force || sourceChanged ? { forceRefresh: true } : undefined,
    );
    return applyCatalogModels(toLocalCatalogModels(available.models), {
      requireManagedDefault: false,
    });
  } catch (error) {
    debugLog("remote-model-catalog", "local pi-ai catalog refresh errored", {
      error: String(error),
    });
    return false;
  }
}

/**
 * Refresh the live model catalog from the cloud endpoint.
 *
 * Local mode uses backend.listModels()/pi-ai. API mode uses the authenticated
 * cloud endpoint and persisted cache. Cloud requests are throttled by TTL and
 * deduped in flight; failures never disturb a valid cache.
 */
export async function refreshModelCatalog(options?: {
  force?: boolean;
}): Promise<boolean> {
  if (resolveBackendMode() !== "api") {
    return refreshLocalModelCatalog(options);
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
  models.splice(0, models.length);
}
