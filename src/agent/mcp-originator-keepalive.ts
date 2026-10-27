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
let verifyTimeoutMs = VERIFY_TIMEOUT_MS;

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
    const result = await verifyWithHardBound(token, verifyTimeoutMs);
    // Exact-token gate (evil-shub round-6 P1, extended round-8): the token
    // was captured BEFORE the await, and a fresh delivery may have
    // installed a newer token while the request was in flight (the producer
    // re-mints per delivery and revokes the prior one). A stale verdict —
    // valid OR invalid — belongs to the superseded token: touch NOTHING.
    // The replacement was installed with a fresh failure budget and is
    // verified on its own tick.
    if (entry.hooks?.getToken() !== token) {
      return;
    }
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
    // Exact-token gate on the failure path too (evil-shub round-9 P1): the
    // captured token may have been replaced while the request was in
    // flight, and the replacement was installed with a fresh failure
    // budget. A stale transport error belongs to the superseded token —
    // charging it here would burn the replacement's budget and could stop
    // renewal for a healthy token. The finally below still reschedules, so
    // the replacement's chain (and any verifyAsap it requested) survives.
    if (entry.hooks?.getToken() !== token) {
      return;
    }
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
 * Hard time bound on one verify call (evil-shub round-8 P1). The verify
 * path passes an AbortSignal, but apiRequest may perform an OAuth token
 * refresh pre-fetch that never observes the signal — a hung refresh would
 * otherwise await forever inside the tick, hold the tick guard
 * (ticking=true), and silently stop ALL renewal until the token expired.
 * Any settlement after the deadline is discarded; both handlers are
 * attached from the start so a late rejection cannot surface as an
 * unhandled rejection.
 */
function verifyWithHardBound(
  token: string,
  budgetMs: number,
): Promise<VerifyResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `[mcp-originator-keepalive] verify exceeded the ${budgetMs}ms hard bound`,
        ),
      );
    }, budgetMs);
    // Deliberately NOT unref'd (evil-shub round-9 P1, Windows shard-6): this
    // deadline is awaited correctness machinery, not background bookkeeping.
    // Unref'd, the bound only holds while something else keeps the event
    // loop alive — on a drained loop (observed: exact-head Windows CI) the
    // timer never fires and a hung underlying verify hangs the suite until
    // the job timeout. The timer is cleared on settlement, so referencing
    // it cannot hold the process open unless the underlying op itself is
    // hung — exactly the case the bound exists to catch. The renewal
    // scheduler timers below stay unref'd: they are background bookkeeping
    // and must not hold the process open.
    verifyImpl(token, AbortSignal.timeout(budgetMs)).then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
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
  config: {
    verify?: VerifyFn;
    intervalMs?: number;
    verifyTimeoutMs?: number;
  } | null,
): void {
  stopAllMcpOriginatorKeepalives();
  verifyImpl = config?.verify ?? defaultVerify;
  intervalMs = config?.intervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
  verifyTimeoutMs = config?.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS;
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
