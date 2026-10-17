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
/**
 * Failure retry delays (evil-shub round-6 P1): a failed tick must retry
 * WITHIN the remaining 300s lease — under the old full-interval spacing
 * three strikes at 120/240/360s meant the token expired before the third
 * attempt. 15s/30s keeps every retry well inside the window.
 */
const FAILURE_RETRY_DELAYS_MS = [15_000, 30_000] as const;
/**
 * Bounded verify fetch (evil-shub round-6 P1): an unbounded request holds
 * the tick guard forever, so one hung connection silently stopped renewal
 * until the token expired. 30s is far above any healthy verify RTT.
 */
const VERIFY_TIMEOUT_MS = 30_000;

type VerifyResult = { valid: boolean };
type VerifyFn = (token: string, signal: AbortSignal) => Promise<VerifyResult>;

const defaultVerify: VerifyFn = async (token, signal) =>
  apiRequest<VerifyResult>(
    "POST",
    "/v1/mcp-originator-tokens/verify",
    { token },
    { signal },
  );

let verifyImpl: VerifyFn = defaultVerify;
let intervalMs = DEFAULT_KEEPALIVE_INTERVAL_MS;

type KeepaliveEntry = {
  /** Undefined in tests, where ticks are driven manually and no timer fires. */
  timer: ReturnType<typeof setTimeout> | undefined;
  consecutiveFailures: number;
  /** Guards against overlapping ticks (a slow verify outliving the interval). */
  ticking: boolean;
  /**
   * Set when a fresh token is installed mid-flight: the next scheduled tick
   * fires immediately so a re-minted pair is verified promptly rather than
   * after a full healthy-cadence interval.
   */
  verifyAsap: boolean;
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

/**
 * Real timers exist only outside tests: test environments register
 * timer-less entries and drive ticks explicitly, so no verify ever fires
 * from the event loop. configureMcpOriginatorKeepaliveForTests disables
 * scheduling as a side effect — production never calls it.
 */
let schedulingEnabled = process.env.NODE_ENV !== "test";

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
    const result = await verifyImpl(
      token,
      AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    );
    entry.consecutiveFailures = 0;
    if (!result.valid) {
      // Stale-verdict guard (evil-shub round-6 P1): the token was captured
      // BEFORE the await, and a fresh delivery may have installed a newer
      // token while the request was in flight (the producer re-mints per
      // delivery and revokes the prior one — so the OLD token's
      // { valid: false } is expected and must never withdraw the NEW one).
      // Withdraw only when the store still holds exactly the verified token.
      const current = entry.hooks?.getToken();
      if (current !== token) {
        // Verdict belongs to a superseded token; the fresh token is
        // verified on its own tick. The failure counter was already reset
        // by startMcpOriginatorKeepalive at install.
        return;
      }
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
    // Reschedule INSIDE the finally so every exit path — including the
    // stale-verdict early return — keeps the renewal chain alive (Amelia
    // round-7 P1 r4301745098: an early return above this block otherwise
    // strands the freshly installed token with no next tick). A stop during
    // the await removed the entry, which the identity check below catches.
    // verifyAsap makes a mid-flight re-install verify promptly instead of
    // waiting out the healthy cadence.
    if (schedulingEnabled && keepalives.get(superRunId) === entry) {
      const delay = entry.verifyAsap
        ? 0
        : nextDelayMs(entry.consecutiveFailures);
      entry.verifyAsap = false;
      entry.timer = setTimeout(() => {
        void runKeepaliveTick(superRunId);
      }, delay);
      entry.timer?.unref();
    }
  }
}

function nextDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return intervalMs;
  const lastDelay = FAILURE_RETRY_DELAYS_MS[FAILURE_RETRY_DELAYS_MS.length - 1];
  return (
    FAILURE_RETRY_DELAYS_MS[
      Math.min(consecutiveFailures, FAILURE_RETRY_DELAYS_MS.length) - 1
    ] ??
    lastDelay ??
    intervalMs
  );
}

/**
 * Ensure a keepalive is running for a run holding a live token entry.
 * Idempotent per run; called by the token store on every entry install.
 * A RE-install (a fresh delivery replacing the held token) refreshes the
 * hooks and resets the failure counter (evil-shub round-6 P1): strikes
 * against the old token must not bleed into the new one's renewal budget.
 */
export function startMcpOriginatorKeepalive(
  superRunId: string,
  hooks: KeepaliveHooks,
): void {
  const existing = keepalives.get(superRunId);
  if (existing) {
    existing.hooks = hooks;
    existing.consecutiveFailures = 0;
    // A re-minted pair deserves prompt verification (the producer re-mints
    // per delivery, often because something changed): if a tick is in
    // flight its finally honors verifyAsap; otherwise replace whatever
    // healthy-cadence timer is pending with an immediate one.
    existing.verifyAsap = true;
    if (schedulingEnabled && !existing.ticking) {
      clearTimeout(existing.timer);
      // The immediate timer IS the prompt verification; leave verifyAsap
      // set only for the in-flight case, where the tick's finally
      // consumes it.
      existing.verifyAsap = false;
      existing.timer = setTimeout(() => {
        void runKeepaliveTick(superRunId);
      }, 0);
      existing.timer?.unref();
    }
    return;
  }
  const entry: KeepaliveEntry = {
    // First tick is IMMEDIATE (evil-shub round-6 P1): the publish gate
    // admits pairs with only a minimum lease left, and a first verify 120s
    // later could find the token already dead. Verifying at install also
    // surfaces a revoked pair before the first tool call needs it. Tests
    // register the entry with NO timer and drive ticks manually.
    timer: schedulingEnabled
      ? setTimeout(() => {
          void runKeepaliveTick(superRunId);
        }, 0)
      : undefined,
    consecutiveFailures: 0,
    ticking: false,
    verifyAsap: false,
    hooks,
  };
  entry.timer?.unref();
  keepalives.set(superRunId, entry);
}

/** Stop renewing a run's token (entry removal, tombstone, store clear). */
export function stopMcpOriginatorKeepalive(superRunId: string): void {
  const entry = keepalives.get(superRunId);
  if (!entry) return;
  clearTimeout(entry.timer);
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
  // Only tests call this; never let a configured (or restored) environment
  // grow real timers.
  schedulingEnabled = false;
}

/** Test-only: synchronously drive one tick for a run. */
export async function runMcpOriginatorKeepaliveTickForTests(
  superRunId: string,
): Promise<void> {
  // Tick even without a registered interval entry by registering a
  // timer-less stub, mirroring production guard behavior.
  if (!keepalives.has(superRunId)) {
    keepalives.set(superRunId, {
      timer: undefined,
      consecutiveFailures: 0,
      ticking: false,
      verifyAsap: false,
    });
  }
  await runKeepaliveTick(superRunId);
}

/** Test-only: is a keepalive interval registered for this run? */
export function hasMcpOriginatorKeepaliveForTests(superRunId: string): boolean {
  return keepalives.has(superRunId);
}
