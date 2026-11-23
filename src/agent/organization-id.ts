import { getBalanceMetadata } from "@/backend/api/metadata";
import { resolveBackendMode } from "@/backend/backend-mode";

const DEFAULT_TIMEOUT_MS = 5_000;
const FAILURE_RETRY_COOLDOWN_MS = 5 * 60_000;

type GetBalanceFn = typeof getBalanceMetadata;

let cachedOrganizationId: string | undefined;
let pending: Promise<string | undefined> | null = null;
let lastFailureAt: number | null = null;
let generation = 0;

function normalizeOrganizationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "local") return undefined;
  return trimmed;
}

export function setExplicitOrganizationId(value: string | undefined): void {
  const normalized = normalizeOrganizationId(value);
  if (normalized) cachedOrganizationId = normalized;
}

export function peekOrganizationId(): string | undefined {
  return cachedOrganizationId;
}

export interface WarmOrganizationIdOptions {
  getBalance?: GetBalanceFn;
  timeoutMs?: number;
  now?: () => number;
}

export function warmOrganizationId(
  options: WarmOrganizationIdOptions = {},
): Promise<string | undefined> {
  if (cachedOrganizationId) return Promise.resolve(cachedOrganizationId);
  if (pending) return pending;
  if (resolveBackendMode() === "local") return Promise.resolve(undefined);
  if (!options.getBalance && process.env.NODE_ENV === "test") {
    return Promise.resolve(undefined);
  }

  const now = options.now ?? Date.now;
  if (
    lastFailureAt !== null &&
    now() - lastFailureAt < FAILURE_RETRY_COOLDOWN_MS
  ) {
    return Promise.resolve(undefined);
  }

  const getBalance = options.getBalance ?? getBalanceMetadata;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const startedGeneration = generation;
  const attempt = (async (): Promise<string | undefined> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const balance = await getBalance({ signal: controller.signal });
      return normalizeOrganizationId(balance?.organization_id);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  })().then((organizationId) => {
    if (startedGeneration !== generation) return undefined;
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

export function clearOrganizationId(): void {
  generation++;
  cachedOrganizationId = undefined;
  pending = null;
  lastFailureAt = null;
}

export function __resetOrganizationIdForTests(): void {
  clearOrganizationId();
}
