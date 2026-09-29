import type { Run } from "@letta-ai/letta-client/resources/agents/messages";
import { getBackend } from "@/backend";
import {
  type AgentRuntimeStatusSnapshot,
  getAgentRuntimeStatus,
} from "@/backend/api/agents";
import {
  dequeueConversationMessage,
  type EnqueueReceipt,
  type ExactSuperRun,
  getExactSuperRun,
} from "@/backend/api/conversation-enqueue";
import { ApiRequestError } from "@/backend/api/request";
import { getErrorMessage } from "@/utils/error";

export type RemoteCancellationResult =
  | { status: "confirmed" }
  | { status: "unconfirmed"; detail: string };

interface RemoteTurnCancelDeps {
  dequeue: typeof dequeueConversationMessage;
  exact: typeof getExactSuperRun;
  cancelRun: (
    agentId: string,
    runId: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
  cancelConversationRun: (
    conversationId: string,
    runId: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
  retrieveRun: (runId: string, signal: AbortSignal) => Promise<Run>;
  runtimeStatus: (
    agentId: string,
    conversationIds: string[],
    signal?: AbortSignal,
  ) => Promise<AgentRuntimeStatusSnapshot>;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
}

async function withinDeadline<T>(
  deadline: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error("Remote cancellation deadline elapsed");
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error("Remote cancellation deadline elapsed");
      controller.abort(error);
      reject(error);
    }, remainingMs);
  });
  try {
    return await Promise.race([operation(controller.signal), expired]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isAbsent(error: unknown): boolean {
  return (
    (error instanceof ApiRequestError && error.status === 404) ||
    (typeof error === "object" &&
      error !== null &&
      Reflect.get(error, "status") === 404)
  );
}

function isDeadlineError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "Remote cancellation deadline elapsed"
  );
}

function isTerminalSuperRun(run: ExactSuperRun): boolean {
  return Boolean(
    run.status === "COM" ||
      run.status === "CAN" ||
      run.completed_at ||
      run.cancelled_at ||
      run.errored_at,
  );
}

function isTerminalRun(run: Run): boolean {
  return (
    typeof run.status === "string" &&
    ["completed", "failed", "cancelled"].includes(run.status)
  );
}

function cancellationAccepted(response: unknown, runId: string): boolean {
  return (
    typeof response === "object" &&
    response !== null &&
    Reflect.get(response, runId) === "cancelled"
  );
}

/** Cancel and verify only the Cloud work correlated to this accepted receipt. */
export async function cancelAcceptedRemoteTurn(
  receipt: EnqueueReceipt,
  overrides: Partial<RemoteTurnCancelDeps> = {},
): Promise<RemoteCancellationResult> {
  const backend = getBackend();
  const deps: RemoteTurnCancelDeps = {
    dequeue: dequeueConversationMessage,
    exact: getExactSuperRun,
    cancelRun: (agentId, runId, signal) =>
      backend.cancelRun(agentId, runId, { signal }),
    cancelConversationRun: (conversationId, runId, signal) =>
      backend.cancelConversationRun(conversationId, runId, { signal }),
    retrieveRun: (runId, signal) => backend.retrieveRun(runId, { signal }),
    runtimeStatus: getAgentRuntimeStatus,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs: 10_000,
    pollMs: 250,
    ...overrides,
  };
  const deadline = Date.now() + deps.timeoutMs;
  let runIds: string[] = [];
  const cancellationRequested = new Set<string>();
  let lastDetail = "the accepted Cloud run is still non-terminal";
  let authoritativelyDequeued = false;

  try {
    const dequeue = await withinDeadline(deadline, (signal) =>
      deps.dequeue(
        {
          agentId: receipt.agent_id,
          conversationId: receipt.conversation_id,
          clientMessageId: receipt.client_message_id,
        },
        signal,
      ),
    );
    authoritativelyDequeued = dequeue.status === "dequeued";
  } catch (error) {
    lastDetail = `queue cancellation failed: ${getErrorMessage(error)}`;
  }

  while (Date.now() <= deadline) {
    let exact: ExactSuperRun;
    try {
      exact = await withinDeadline(deadline, (signal) =>
        deps.exact(receipt.agent_id, receipt.super_run_id, signal),
      );
    } catch (error) {
      if (isDeadlineError(error)) break;
      if (isAbsent(error) && authoritativelyDequeued)
        return { status: "confirmed" };
      lastDetail = `exact Super Run status could not be read: ${getErrorMessage(error)}`;
      try {
        await withinDeadline(deadline, () => deps.sleep(deps.pollMs));
      } catch {
        break;
      }
      continue;
    }
    if (exact.id !== receipt.super_run_id) {
      lastDetail = `exact status returned ${exact.id} instead of ${receipt.super_run_id}`;
      break;
    }
    runIds = exact.run_ids;
    const uncancelledRunIds = runIds.filter(
      (runId) => !cancellationRequested.has(runId),
    );
    if (uncancelledRunIds.length > 0) {
      const requests =
        receipt.conversation_id === "default"
          ? await Promise.allSettled(
              uncancelledRunIds.map((runId) =>
                withinDeadline(deadline, (signal) =>
                  deps.cancelRun(receipt.agent_id, runId, signal),
                ),
              ),
            )
          : await Promise.allSettled(
              uncancelledRunIds.map((runId) =>
                withinDeadline(deadline, (signal) =>
                  deps.cancelConversationRun(
                    receipt.conversation_id,
                    runId,
                    signal,
                  ),
                ),
              ),
            );
      let rejected: PromiseRejectedResult | undefined;
      for (const [index, result] of requests.entries()) {
        const runId = uncancelledRunIds[index];
        if (
          result.status === "fulfilled" &&
          runId &&
          cancellationAccepted(result.value, runId)
        )
          cancellationRequested.add(runId);
        else if (result.status === "rejected") rejected ??= result;
        else if (runId)
          rejected ??= {
            status: "rejected",
            reason: new Error(
              `Cloud did not accept exact cancellation for ${runId}`,
            ),
          };
      }
      if (rejected)
        lastDetail = `scoped run cancellation failed: ${getErrorMessage(rejected.reason)}`;
    }
    if (isTerminalSuperRun(exact)) {
      const statuses = await Promise.all(
        runIds.map(async (runId) => {
          try {
            return isTerminalRun(
              await withinDeadline(deadline, (signal) =>
                deps.retrieveRun(runId, signal),
              ),
            );
          } catch {
            return false;
          }
        }),
      );
      if (statuses.every(Boolean)) {
        try {
          const runtime = await withinDeadline(deadline, (signal) =>
            deps.runtimeStatus(
              receipt.agent_id,
              [receipt.conversation_id],
              signal,
            ),
          );
          const conversation = runtime.statuses.find(
            (entry) => entry.conversation_id === receipt.conversation_id,
          );
          const inactive =
            runIds.length === 0
              ? authoritativelyDequeued &&
                conversation?.active_run_ids.length === 0
              : Boolean(
                  conversation &&
                    runIds.every(
                      (runId) => !conversation.active_run_ids.includes(runId),
                    ),
                );
          if (inactive) return { status: "confirmed" };
          lastDetail =
            runIds.length === 0
              ? "the accepted Super Run has no correlated run ID without proof that the target conversation is inactive"
              : "the accepted Super Run settled but its correlated run is still active in the runtime";
        } catch (error) {
          if (!isDeadlineError(error))
            lastDetail = `runtime activity could not be verified: ${getErrorMessage(error)}`;
        }
      } else {
        lastDetail =
          "the accepted Super Run settled but a correlated run is still non-terminal";
      }
    } else if (runIds.length === 0) {
      lastDetail =
        "the accepted Super Run has no correlated run ID and is still non-terminal";
    }
    try {
      await withinDeadline(deadline, () => deps.sleep(deps.pollMs));
    } catch {
      break;
    }
  }

  return {
    status: "unconfirmed",
    detail: `Remote cancellation unconfirmed for accepted Super Run ${receipt.super_run_id}: ${lastDetail}.`,
  };
}
