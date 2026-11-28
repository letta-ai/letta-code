import { getRetryDelayMs } from "@/agent/turn-recovery-policy";
import { getBackend } from "@/backend";
import { emitRetryDelta } from "./protocol-outbound";
import type { ListenerTransport } from "./transport";
import type { ConversationRuntime } from "./types";

const ACTIVE_BLOCKING_RUN_STATUSES = new Set(["created", "running"]);
export const BUSY_RUN_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const BUSY_RUN_POLL_INTERVAL_MS = 5000;
export const MAX_CONVERSATION_BUSY_RETRIES = 3;
const MAX_BUSY_RETRY_DELAY_MS = 30_000;
const MAX_BUSY_WAIT_ATTEMPTS =
  1 + Math.ceil((BUSY_RUN_WAIT_TIMEOUT_MS - 10_000) / MAX_BUSY_RETRY_DELAY_MS);

export type BusyRetryState = {
  runRetries: number;
  lockAttempts: number;
  lockDeadline: number | null;
  retriedAfterSettled: Set<string>;
};

type BlockingRunWaitResult = "settled" | "timed_out" | "unavailable";

function isBlockingRunActive(status: unknown): boolean {
  return typeof status === "string" && ACTIVE_BLOCKING_RUN_STATUSES.has(status);
}

async function sleepWithAbort(
  delayMs: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;

    function cleanup() {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      abortSignal?.removeEventListener("abort", onAbort);
    }

    function onAbort() {
      cleanup();
      reject(new Error("Cancelled by user"));
    }

    if (abortSignal?.aborted) {
      onAbort();
      return;
    }

    abortSignal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
  });
}

async function waitForBlockingRunToSettle(
  runId: string,
  abortSignal?: AbortSignal,
): Promise<BlockingRunWaitResult> {
  const timeoutMs = BUSY_RUN_WAIT_TIMEOUT_MS;
  const startedAt = Date.now();

  while (true) {
    if (abortSignal?.aborted) {
      throw new Error("Cancelled by user");
    }

    let run: Awaited<ReturnType<ReturnType<typeof getBackend>["retrieveRun"]>>;
    try {
      run = await getBackend().retrieveRun(runId);
    } catch {
      return "unavailable";
    }

    if (!isBlockingRunActive(run.status)) {
      return "settled";
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      return "timed_out";
    }

    await sleepWithAbort(
      Math.min(BUSY_RUN_POLL_INTERVAL_MS, timeoutMs - elapsedMs),
      abortSignal,
    );
  }
}

async function maybeWaitForBlockingRun(params: {
  runId: string | null;
  retriedAfterSettled: Set<string>;
  abortSignal?: AbortSignal;
}): Promise<"retry_now" | "fall_back"> {
  const { runId, retriedAfterSettled, abortSignal } = params;
  if (!runId) {
    return "fall_back";
  }

  const waitResult = await waitForBlockingRunToSettle(runId, abortSignal);

  if (waitResult === "settled") {
    if (retriedAfterSettled.has(runId)) {
      return "fall_back";
    }
    retriedAfterSettled.add(runId);
    return "retry_now";
  }

  if (waitResult === "timed_out") {
    throw new Error(
      `Conversation is still busy because run ${runId} remained active after ${BUSY_RUN_WAIT_TIMEOUT_MS}ms`,
    );
  }

  return "fall_back";
}

function getConversationBusyRetryNotice(
  blockingRunId: string | null,
  retryDelayMs: number,
): { message: string; delayMs: number } {
  if (!blockingRunId) {
    return {
      message: "Conversation is busy, waiting and retrying…",
      delayMs: retryDelayMs,
    };
  }

  return {
    message: `Conversation is busy; waiting for run ${blockingRunId} to finish…`,
    delayMs: BUSY_RUN_POLL_INTERVAL_MS,
  };
}

export async function waitToRetryBusyConversation(params: {
  state: BusyRetryState;
  blockingRunId: string | null;
  retryBudgetAvailable: boolean;
  error: unknown;
  socket: ListenerTransport;
  runtime: ConversationRuntime;
  conversationId: string;
  abortSignal: AbortSignal;
  authorityGuard?: () => boolean;
}): Promise<void> {
  const {
    state,
    blockingRunId,
    retryBudgetAvailable,
    error,
    socket,
    runtime,
    conversationId,
    abortSignal,
    authorityGuard,
  } = params;
  const attempt = blockingRunId ? state.runRetries + 1 : ++state.lockAttempts;
  if (blockingRunId && retryBudgetAvailable) {
    state.runRetries = attempt;
  }

  const backoff = getRetryDelayMs({ category: "conversation_busy", attempt });
  const deadline = blockingRunId ? null : state.lockDeadline;
  const delayMs =
    deadline === null
      ? backoff
      : Math.min(
          backoff,
          MAX_BUSY_RETRY_DELAY_MS,
          deadline - performance.now(),
        );
  if (delayMs <= 0) {
    throw error;
  }

  const notice = getConversationBusyRetryNotice(blockingRunId, delayMs);
  emitRetryDelta(socket, runtime, {
    message: notice.message,
    reason: "error",
    attempt,
    maxAttempts: blockingRunId
      ? MAX_CONVERSATION_BUSY_RETRIES
      : MAX_BUSY_WAIT_ATTEMPTS,
    delayMs: notice.delayMs,
    agentId: runtime.agentId ?? undefined,
    conversationId,
  });

  if (blockingRunId) {
    const disposition = await maybeWaitForBlockingRun({
      runId: blockingRunId,
      retriedAfterSettled: state.retriedAfterSettled,
      abortSignal,
    });
    if (disposition === "retry_now") {
      return;
    }
    if (!retryBudgetAvailable) {
      throw error;
    }
  }

  await sleepWithAbort(delayMs, abortSignal);
  if (deadline !== null) {
    if (authorityGuard?.() === false) {
      throw new Error("Recovery ownership lost");
    }
    if (abortSignal.aborted) {
      throw new Error("Cancelled by user");
    }
    if (performance.now() >= deadline) {
      throw error;
    }
  }
}
