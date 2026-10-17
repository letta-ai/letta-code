/**
 * Active-turn renewal for MCP originator tokens (USER_SCOPED_MCP_CONNECTIONS).
 *
 * The server slides a pair's TTL back to the full 300s window on every
 * successful verify — which today means on every MCP tool call carrying the
 * header. A turn whose tool calls are spaced further apart than that window
 * (long LLM generations, approval waits, sandbox stalls) would find its
 * token expired at the next call and silently continue unattributed
 * (evil-shub round-5 P1 lease/renewal). While this process holds a live
 * token entry for a run, this module pings
 * POST /v1/mcp-originator-tokens/verify on an interval comfortably below
 * the sliding TTL, keeping the pair alive for exactly as long as the token
 * is held — never longer: tombstones, retirements, withdrawals, and store
 * clears all stop the keepalive, and the absolute 1h ceiling binds
 * server-side regardless.
 *
 * Renewal is not authority: a token the server has revoked or fenced comes
 * back { valid: false }, the local entry is withdrawn immediately, and the
 * turn continues headerless. Network failures tolerate three consecutive
 * ticks before giving up loudly; the server-side TTL remains the bound.
 * The token value is never logged.
 */

import { apiRequest } from "@/backend/api/request";

/** 120s: below the 300s sliding TTL with a full missed tick of slack. */
const DEFAULT_KEEPALIVE_INTERVAL_MS = 120_000;
const MAX_CONSECUTIVE_FAILURES = 3;

type VerifyResult = { valid: boolean };
type VerifyFn = (token: string) => Promise<VerifyResult>;

const defaultVerify: VerifyFn = async (token) =>
  apiRequest<VerifyResult>("POST", "/v1/mcp-originator-tokens/verify", {
    token,
  });

let verifyImpl: VerifyFn = defaultVerify;
let intervalMs = DEFAULT_KEEPALIVE_INTERVAL_MS;

type KeepaliveEntry = {
  timer: ReturnType<typeof setInterval>;
  consecutiveFailures: number;
  /** Guards against overlapping ticks (a slow verify outliving the interval). */
  ticking: boolean;
  /**
   * Store access injected at start. Optional: the test-only tick driver
   * registers a timer-less stub without store access, which the tick
   * treats exactly like a vanished entry (stop, never verify).
   */
  hooks?: KeepaliveHooks;
};

/**
 * Store access is injected by the caller (the token store) so this module
 * never imports the store: the dependency points one way
 * (store → keepalive), which keeps the import graph acyclic.
 */
export type KeepaliveHooks = {
  /** Current raw token for the run, or undefined once the entry is gone. */
  getToken: () => string | undefined;
  /** Withdraw the entry after a server denial (turn continues headerless). */
  withdraw: () => void;
};

const keepalives = new Map<string, KeepaliveEntry>();

async function runKeepaliveTick(superRunId: string): Promise<void> {
  const entry = keepalives.get(superRunId);
  if (!entry || entry.ticking) return;
  const token = entry.hooks?.getToken();
  if (!token) {
    // Entry vanished (tombstone, retirement, withdrawal): stop renewing.
    stopMcpOriginatorKeepalive(superRunId);
    return;
  }
  entry.ticking = true;
  try {
    const result = await verifyImpl(token);
    entry.consecutiveFailures = 0;
    if (!result.valid) {
      // The server denies this token (revoked, fenced, or aged past its
      // ceiling): withdraw locally so the turn continues headerless instead
      // of spending a dead header, and stop renewing.
      console.warn(
        `[mcp-originator-keepalive] server denied the originator token for super run ${superRunId}; withdrawing it (turn continues unattributed)`,
      );
      entry.hooks?.withdraw();
      stopMcpOriginatorKeepalive(superRunId);
      return;
    }
  } catch (error) {
    entry.consecutiveFailures += 1;
    if (entry.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(
        `[mcp-originator-keepalive] renewal failed ${entry.consecutiveFailures} times for super run ${superRunId}; stopping renewal (the server-side TTL now bounds the token):`,
        error instanceof Error ? error.message : error,
      );
      stopMcpOriginatorKeepalive(superRunId);
      return;
    }
  } finally {
    entry.ticking = false;
  }
}

/**
 * Ensure a keepalive is running for a run holding a live token entry.
 * Idempotent per run; called by the token store on every entry install.
 */
export function startMcpOriginatorKeepalive(
  superRunId: string,
  hooks: KeepaliveHooks,
): void {
  if (keepalives.has(superRunId)) return;
  if (process.env.NODE_ENV === "test" && verifyImpl === defaultVerify) {
    // Tests drive ticks explicitly through runMcpOriginatorKeepaliveTickForTests
    // or install a verify stub via configureMcpOriginatorKeepaliveForTests;
    // never let a default-configured interval fire real HTTP from a test.
    return;
  }
  const timer = setInterval(() => {
    void runKeepaliveTick(superRunId);
  }, intervalMs);
  timer.unref();
  keepalives.set(superRunId, {
    timer,
    consecutiveFailures: 0,
    ticking: false,
    hooks,
  });
}

/** Stop renewing a run's token (entry removal, tombstone, store clear). */
export function stopMcpOriginatorKeepalive(superRunId: string): void {
  const entry = keepalives.get(superRunId);
  if (!entry) return;
  clearInterval(entry.timer);
  keepalives.delete(superRunId);
}

/** Stop every keepalive (listener session teardown, tests). */
export function stopAllMcpOriginatorKeepalives(): void {
  for (const runId of [...keepalives.keys()]) {
    stopMcpOriginatorKeepalive(runId);
  }
}

/** Test-only: install a verify stub and/or a shorter interval; pass null to restore. */
export function configureMcpOriginatorKeepaliveForTests(
  config: { verify?: VerifyFn; intervalMs?: number } | null,
): void {
  stopAllMcpOriginatorKeepalives();
  verifyImpl = config?.verify ?? defaultVerify;
  intervalMs = config?.intervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
}

/** Test-only: synchronously drive one tick for a run. */
export async function runMcpOriginatorKeepaliveTickForTests(
  superRunId: string,
): Promise<void> {
  // Tick even without a registered interval entry by registering a
  // timer-less stub, mirroring production guard behavior.
  if (!keepalives.has(superRunId)) {
    keepalives.set(superRunId, {
      timer: setInterval(() => {}, Number.MAX_SAFE_INTEGER),
      consecutiveFailures: 0,
      ticking: false,
    });
    clearInterval(keepalives.get(superRunId)?.timer);
  }
  await runKeepaliveTick(superRunId);
}

/** Test-only: is a keepalive interval registered for this run? */
export function hasMcpOriginatorKeepaliveForTests(superRunId: string): boolean {
  return keepalives.has(superRunId);
}
