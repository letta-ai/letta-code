import { debugWarn } from "@/utils/debug";
import type { TurnLease } from "./turn-lifecycle";
import type { ConversationRuntime } from "./types";

export function fenceLostRecoveryClaim(
  runtime: ConversationRuntime,
  lease: TurnLease | undefined,
  sideEffectMayHaveRun: boolean,
): void {
  if (
    !sideEffectMayHaveRun &&
    lease &&
    runtime.turnLifecycle.isCurrent(lease)
  ) {
    runtime.turnLifecycle.requestCancellation({ cause: "transport" });
  }
}

type RetryState = {
  scheduled: boolean;
  attempt: number;
  generation: string | null;
  retry: () => Promise<unknown>;
  version: number;
  timer?: ReturnType<typeof setTimeout>;
};
const retryStates = new WeakMap<ConversationRuntime, RetryState>();
const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

function retryDelay(attempt: number): number {
  const ceiling = Math.min(
    MAX_RETRY_DELAY_MS,
    INITIAL_RETRY_DELAY_MS * 2 ** Math.min(attempt, 5),
  );
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
}

/** Coalesce claim-loss recovery after the stale lease has unwound to idle. */
export function scheduleRecoveredApprovalRetry(
  runtime: ConversationRuntime,
  retry: () => Promise<unknown>,
): void {
  const generation = runtime.listener.connectionGeneration ?? null;
  const state = retryStates.get(runtime) ?? {
    scheduled: false,
    attempt: 0,
    generation,
    retry,
    version: 0,
  };
  if (state.generation !== generation) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    state.scheduled = false;
    state.attempt = 0;
    state.generation = generation;
  }
  state.retry = retry;
  if (state.scheduled) return;
  state.scheduled = true;
  state.version += 1;
  const version = state.version;
  retryStates.set(runtime, state);
  setImmediate(() => {
    if (state.version !== version) return;
    state.scheduled = false;
    if (
      runtime.listener.intentionallyClosed ||
      (runtime.listener.connectionGeneration ?? null) !== state.generation
    ) {
      retryStates.delete(runtime);
      return;
    }
    const recovered = runtime.recoveredApprovalState;
    if (!recovered) {
      retryStates.delete(runtime);
      return;
    }
    const scheduleNext = () => {
      if (
        runtime.recoveredApprovalState !== recovered ||
        runtime.listener.intentionallyClosed ||
        (runtime.listener.connectionGeneration ?? null) !== state.generation
      ) {
        retryStates.delete(runtime);
        return;
      }
      const delay = retryDelay(state.attempt);
      state.attempt += 1;
      state.scheduled = true;
      state.timer = setTimeout(() => {
        if (state.version !== version) return;
        state.timer = undefined;
        state.scheduled = false;
        scheduleRecoveredApprovalRetry(runtime, state.retry);
      }, delay);
      state.timer.unref?.();
    };
    void state
      .retry()
      .then((handled) => {
        if (handled === false) scheduleNext();
        else retryStates.delete(runtime);
      })
      .catch((error) => {
        debugWarn("recovery", "Recovered approval retry failed", error);
        scheduleNext();
      });
  });
}
