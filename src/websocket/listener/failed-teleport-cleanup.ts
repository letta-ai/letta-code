import { createInterruptedTurnStore } from "./interrupted-turn-record";
import type { ListenerRuntime, PendingTeleport } from "./types";

export const FAILED_TELEPORT_CLEANUP_MAX_ATTEMPTS = 8;
export const FAILED_TELEPORT_CLEANUP_PENDING_LIMIT = 64;
const FAILED_TELEPORT_CLEANUP_RETRY_DELAY_MS = 100;
const FAILED_TELEPORT_CLEANUP_MAX_RETRY_DELAY_MS = 5_000;

type InterruptedTurnStore = ReturnType<typeof createInterruptedTurnStore>;

type CleanupEntry = {
  pending: PendingTeleport;
  store: InterruptedTurnStore;
  attempts: number;
  maxAttempts: number;
  retryDelayMs: number;
  nextAttemptAt: number;
};

type CleanupState = {
  entries: Map<string, CleanupEntry>;
  timer: ReturnType<typeof setTimeout> | null;
};

const cleanupStates = new WeakMap<ListenerRuntime, CleanupState>();

function cleanupKey(pending: PendingTeleport): string {
  return JSON.stringify([
    pending.agentId,
    pending.conversationId,
    pending.teleportId,
    pending.interruptedRevision,
  ]);
}

function disposeEmptyState(
  listener: ListenerRuntime,
  state: CleanupState,
): void {
  if (state.entries.size !== 0) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  cleanupStates.delete(listener);
}

function scheduleNextPass(
  listener: ListenerRuntime,
  state: CleanupState,
): void {
  if (listener.intentionallyClosed) {
    cancelFailedTeleportCleanup(listener);
    return;
  }
  if (state.timer || state.entries.size === 0) return;
  const now = Date.now();
  const nextAttemptAt = Math.min(
    ...[...state.entries.values()].map((entry) => entry.nextAttemptAt),
  );
  state.timer = setTimeout(
    () => {
      state.timer = null;
      runCleanupPass(listener, state);
    },
    Math.max(0, nextAttemptAt - now),
  );
  state.timer.unref?.();
}

function runCleanupPass(listener: ListenerRuntime, state: CleanupState): void {
  if (listener.intentionallyClosed || cleanupStates.get(listener) !== state) {
    cancelFailedTeleportCleanup(listener);
    return;
  }
  const now = Date.now();
  for (const [key, entry] of state.entries) {
    if (entry.nextAttemptAt > now) continue;
    let completed = false;
    try {
      // The admitted failure owns only the predecessor observed before its
      // durable disposition commit. A false CAS means that exact revision is
      // already gone; never reread and retarget an inheriting successor.
      entry.store.remove(
        entry.pending.agentId,
        entry.pending.conversationId,
        entry.pending.interruptedRevision ?? null,
      );
      completed = true;
    } catch {
      entry.attempts += 1;
      if (entry.attempts >= entry.maxAttempts) {
        // Keep the durable teleport evidence intact. A later process restart can
        // prove the accepted failure disposition and retry this CAS cleanup.
        completed = true;
      } else {
        entry.nextAttemptAt =
          now +
          Math.min(
            FAILED_TELEPORT_CLEANUP_MAX_RETRY_DELAY_MS,
            entry.retryDelayMs * 2 ** (entry.attempts - 1),
          );
      }
    }
    if (completed) state.entries.delete(key);
  }
  disposeEmptyState(listener, state);
  if (cleanupStates.get(listener) === state) scheduleNextPass(listener, state);
}

export type FailedTeleportCleanupDependencies = {
  store?: InterruptedTurnStore;
  retryDelayMs?: number;
  maxAttempts?: number;
  pendingLimit?: number;
};

export function clearAcceptedFailedTeleportBounded(
  listener: ListenerRuntime,
  pending: PendingTeleport,
  dependencies: FailedTeleportCleanupDependencies = {},
): void {
  if (listener.intentionallyClosed || !pending.interruptedRevision) return;
  const key = cleanupKey(pending);
  const state =
    cleanupStates.get(listener) ??
    ({ entries: new Map(), timer: null } satisfies CleanupState);
  if (state.entries.has(key)) return;
  const pendingLimit = Math.max(
    1,
    Math.min(
      FAILED_TELEPORT_CLEANUP_PENDING_LIMIT,
      Math.floor(
        dependencies.pendingLimit ?? FAILED_TELEPORT_CLEANUP_PENDING_LIMIT,
      ),
    ),
  );
  if (state.entries.size >= pendingLimit) return;
  cleanupStates.set(listener, state);
  state.entries.set(key, {
    pending,
    store: dependencies.store ?? createInterruptedTurnStore(),
    attempts: 0,
    maxAttempts: Math.max(
      1,
      Math.min(
        FAILED_TELEPORT_CLEANUP_MAX_ATTEMPTS,
        Math.floor(
          dependencies.maxAttempts ?? FAILED_TELEPORT_CLEANUP_MAX_ATTEMPTS,
        ),
      ),
    ),
    retryDelayMs: Math.max(
      1,
      Math.floor(
        dependencies.retryDelayMs ?? FAILED_TELEPORT_CLEANUP_RETRY_DELAY_MS,
      ),
    ),
    nextAttemptAt: Date.now(),
  });
  runCleanupPass(listener, state);
}

export function cancelFailedTeleportCleanup(listener: ListenerRuntime): void {
  const state = cleanupStates.get(listener);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.entries.clear();
  cleanupStates.delete(listener);
}

export function getFailedTeleportCleanupPendingCount(
  listener: ListenerRuntime,
): number {
  return cleanupStates.get(listener)?.entries.size ?? 0;
}
