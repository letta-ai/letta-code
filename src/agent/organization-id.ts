/**
 * Best-effort resolution of the Letta organization this runtime is signed into.
 *
 * Exposed to agent shells as `LETTA_ORGANIZATION_ID` (see `getShellEnv`).
 * Resolution order:
 *   1. An explicit organization (e.g. `letta server --org <id>`).
 *   2. `GET /v1/environments?limit=1` — entries are scoped to the caller's org.
 *
 * The lookup runs at most once per cooldown window, has a short timeout, and is
 * never awaited by turns or tool calls. On failure the value stays unknown.
 */

import { listEnvironments } from "@/backend/api/environments";
import { resolveBackendMode } from "@/backend/backend-mode";

const DEFAULT_TIMEOUT_MS = 5_000;
const FAILURE_RETRY_COOLDOWN_MS = 5 * 60_000;

type ListEnvironmentsFn = typeof listEnvironments;

let cachedOrganizationId: string | undefined;
let pending: Promise<string | undefined> | null = null;
let lastFailureAt: number | null = null;

function normalizeOrganizationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "local") return undefined;
  return trimmed;
}

/** Record an organization known up front (e.g. `letta server --org`). */
export function setExplicitOrganizationId(value: string | undefined): void {
  const normalized = normalizeOrganizationId(value);
  if (normalized) cachedOrganizationId = normalized;
}

/** Synchronously read the cached organization id, if resolved. */
export function peekOrganizationId(): string | undefined {
  return cachedOrganizationId;
}

export interface WarmOrganizationIdOptions {
  list?: ListEnvironmentsFn;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Start (or join) the one-shot organization lookup. Safe to call often: it
 * returns the cached value or in-flight promise and never throws.
 */
export function warmOrganizationId(
  options: WarmOrganizationIdOptions = {},
): Promise<string | undefined> {
  if (cachedOrganizationId) return Promise.resolve(cachedOrganizationId);
  if (pending) return pending;
  if (resolveBackendMode() === "local") return Promise.resolve(undefined);
  // Keep unrelated tests hermetic: no implicit network lookup under `bun test`.
  if (!options.list && process.env.NODE_ENV === "test") {
    return Promise.resolve(undefined);
  }

  const now = options.now ?? Date.now;
  if (
    lastFailureAt !== null &&
    now() - lastFailureAt < FAILURE_RETRY_COOLDOWN_MS
  ) {
    return Promise.resolve(undefined);
  }

  const list = options.list ?? listEnvironments;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const attempt = (async (): Promise<string | undefined> => {
    const controller = new AbortController();
    // Not unref'd: the lookup is short-lived and cleared in `finally`, and an
    // unref'd timer that is the only pending work may never fire (seen on
    // Windows), which would leave the abort, and the lookup, hanging.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await list({ limit: 1, signal: controller.signal });
      for (const entry of response?.connections ?? []) {
        const organizationId = normalizeOrganizationId(entry?.organizationId);
        if (organizationId) return organizationId;
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  })().then((organizationId) => {
    // An explicit org may have been set while the lookup was in flight.
    if (!cachedOrganizationId && organizationId) {
      cachedOrganizationId = organizationId;
    }
    if (!cachedOrganizationId) lastFailureAt = now();
    pending = null;
    return cachedOrganizationId;
  });

  pending = attempt;
  return attempt;
}

/** Test-only: clear cached state. */
export function __resetOrganizationIdForTests(): void {
  cachedOrganizationId = undefined;
  pending = null;
  lastFailureAt = null;
}
