import { setTimeout as delay } from "node:timers/promises";
import { APIError } from "@letta-ai/letta-client";
import type {
  Message,
  Run,
} from "@letta-ai/letta-client/resources/agents/messages";
import {
  type AgentRuntimeStatusEntry,
  getAgentRuntimeStatus,
} from "@/backend/api/agents";
import {
  type EnqueueReceipt,
  type ExactSuperRun,
  getEnqueueAgentId,
} from "@/backend/api/conversation-enqueue";
import { ApiRequestError } from "@/backend/api/request";
import type { EnqueuedReply } from "@/headless-enqueue-wait";

export interface SuperRunWaitDeps {
  exact: (
    agentId: string,
    superRunId: string,
    signal: AbortSignal,
  ) => Promise<ExactSuperRun>;
  run: (runId: string, signal: AbortSignal) => Promise<Run>;
  messages: (runId: string, signal: AbortSignal) => Promise<Message[]>;
  /**
   * Called with the Super Run's child runs (newest first) while it executes,
   * at most every `progressMs`, and once more when it completes. Failures are
   * ignored: progress is best effort and never ends the wait.
   */
  onProgress?: (runIds: string[], signal: AbortSignal) => Promise<void>;
  progressMs?: number;
  pollMs?: number;
  /** How long a completed Super Run may report no linked child run. */
  runLinkGraceMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * Opt in to returning when the send's turn ends. Cloud completes a Super Run
   * only once the whole conversation runtime drains, so a leftover background
   * process in the recipient can keep the send open after its final reply.
   * Reads the conversation's runtime status; null when unavailable.
   */
  runtimeStatus?: (
    agentId: string,
    conversationId: string,
    signal: AbortSignal,
  ) => Promise<AgentRuntimeStatusEntry | null>;
  /**
   * How long the newest run must stay completed, with no newer run linked,
   * before the turn counts as ended. Lets a notification turn queued right at
   * turn end take over the send.
   */
  turnEndGraceMs?: number;
}

class RemoteExecutionFailed extends Error {}

/** The server can link a child run to its Super Run after marking it complete. */
const DEFAULT_RUN_LINK_GRACE_MS = 60_000;
const DEFAULT_TURN_END_GRACE_MS = 5_000;

/** Default `runtimeStatus` dep: the conversation's Cloud runtime-status entry. */
export async function readConversationRuntimeStatus(
  agentId: string,
  conversationId: string,
  signal: AbortSignal,
): Promise<AgentRuntimeStatusEntry | null> {
  const snapshot = await getAgentRuntimeStatus(
    agentId,
    [conversationId],
    signal,
  );
  return (
    snapshot.statuses.find(
      (status) => status.conversation_id === conversationId,
    ) ?? null
  );
}

function isTransientReadError(error: unknown): boolean {
  if (error instanceof ApiRequestError || error instanceof APIError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return (
    error instanceof TypeError ||
    (error instanceof Error && error.name === "TimeoutError")
  );
}

async function retryRead<T>(
  read: () => Promise<T>,
  signal: AbortSignal,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  failureLabel: string,
): Promise<T> {
  let failures = 0;
  while (true) {
    signal.throwIfAborted();
    try {
      return await read();
    } catch (error) {
      signal.throwIfAborted();
      if (!isTransientReadError(error)) {
        throw new RemoteExecutionFailed(
          `${failureLabel}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await sleep(
        Math.min(30_000, 1_000 * 2 ** Math.min(failures++, 5)),
        signal,
      );
    }
  }
}

function throwIfSuperRunFailed(run: ExactSuperRun): void {
  if (run.errored_at) {
    const detail = run.error
      ? ` during ${run.error.code}: ${run.error.message}`
      : "";
    throw new RemoteExecutionFailed(
      `Remote Super Run ${run.id} failed${detail}`,
    );
  }
  if (run.status === "CAN" || run.cancelled_at) {
    throw new RemoteExecutionFailed(
      `Remote Super Run ${run.id} was cancelled.`,
    );
  }
}

function assistantText(messages: Message[]): string | null {
  const assistant = messages
    .filter((message) => message.message_type === "assistant_message")
    .sort((left, right) => (right.seq_id ?? 0) - (left.seq_id ?? 0))[0];
  if (assistant?.message_type !== "assistant_message") return null;
  const text =
    typeof assistant.content === "string"
      ? assistant.content
      : assistant.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
  return text.trim() ? text : null;
}

function noReplyMessage(receipt: EnqueueReceipt): string {
  return `Remote task finished. Its reply was not collected. Read the conversation with: letta messages list --agent ${getEnqueueAgentId(receipt)} --conversation ${receipt.conversation_id}. Do not launch the task again to retrieve its result.`;
}

/** Follow the exact accepted send. Reads may retry; the task is never resubmitted. */
export async function waitForAcceptedSuperRun(
  receipt: EnqueueReceipt,
  signal: AbortSignal,
  deps: SuperRunWaitDeps,
): Promise<EnqueuedReply> {
  const pollMs = deps.pollMs ?? 1_000;
  const runLinkGraceMs = deps.runLinkGraceMs ?? DEFAULT_RUN_LINK_GRACE_MS;
  let completedWithoutRunSince: number | undefined;
  const progressMs = deps.progressMs ?? 3_000;
  let lastProgressAt: number | undefined;
  const reportProgress = async (runIds: string[], force: boolean) => {
    if (!deps.onProgress || runIds.length === 0) return;
    const now = Date.now();
    if (
      !force &&
      lastProgressAt !== undefined &&
      now - lastProgressAt < progressMs
    ) {
      return;
    }
    lastProgressAt = now;
    try {
      await deps.onProgress(
        runIds,
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      );
    } catch {
      signal.throwIfAborted();
    }
  };
  const sleep =
    deps.sleep ??
    ((ms: number, waitSignal: AbortSignal) =>
      delay(ms, undefined, { signal: waitSignal }));
  const turnEndGraceMs = deps.turnEndGraceMs ?? DEFAULT_TURN_END_GRACE_MS;
  let turnEnd: { runId: string; since: number; noReply: boolean } | undefined;
  // The Super Run is still open. Its turn is over when the newest linked run
  // completed with a reply, no newer run took over within the grace window,
  // and the listener is waiting on input with none of this send's runs live.
  // Anything else (including read errors) keeps the normal wait.
  const replyAtTurnEnd = async (
    exact: ExactSuperRun,
  ): Promise<EnqueuedReply | null> => {
    const runId = exact.run_ids[0];
    if (!deps.runtimeStatus || !runId) return null;
    if (turnEnd?.runId === runId && turnEnd.noReply) return null;
    try {
      const readSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      const run = await deps.run(runId, readSignal);
      if (
        run.status !== "completed" ||
        run.stop_reason === "requires_approval"
      ) {
        turnEnd = undefined;
        return null;
      }
      if (turnEnd?.runId !== runId) {
        turnEnd = { runId, since: Date.now(), noReply: false };
      }
      if (Date.now() - turnEnd.since < turnEndGraceMs) return null;
      const status = await deps.runtimeStatus(
        getEnqueueAgentId(receipt),
        receipt.conversation_id,
        readSignal,
      );
      if (
        status?.loop_state?.status !== "WAITING_ON_INPUT" ||
        status.active_run_ids.some((id) => exact.run_ids.includes(id))
      ) {
        return null;
      }
      await reportProgress(exact.run_ids, true);
      const text = assistantText(
        await deps.messages(
          runId,
          AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        ),
      );
      if (!text) {
        turnEnd.noReply = true;
        return null;
      }
      return {
        text,
        runIds: exact.run_ids,
        stopReason: run.stop_reason ?? null,
      };
    } catch {
      signal.throwIfAborted();
      return null;
    }
  };

  while (true) {
    signal.throwIfAborted();
    const exact = await retryRead(
      () =>
        deps.exact(
          getEnqueueAgentId(receipt),
          receipt.super_run_id,
          AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        ),
      signal,
      sleep,
      `Cloud status read for accepted Super Run ${receipt.super_run_id} failed`,
    );
    if (exact.id !== receipt.super_run_id) {
      throw new RemoteExecutionFailed(
        `Exact Super Run read returned ${exact.id} for ${receipt.super_run_id}.`,
      );
    }
    throwIfSuperRunFailed(exact);
    const terminal = exact.status === "COM" || exact.completed_at !== null;
    if (!terminal) {
      await reportProgress(exact.run_ids, false);
      const reply = await replyAtTurnEnd(exact);
      if (reply) return reply;
      await sleep(pollMs, signal);
      continue;
    }

    // run_ids is newest first, so this is the run that ended the send.
    const runId = exact.run_ids[0];
    if (!runId) {
      completedWithoutRunSince ??= Date.now();
      if (Date.now() - completedWithoutRunSince < runLinkGraceMs) {
        await sleep(pollMs, signal);
        continue;
      }
      throw new RemoteExecutionFailed(
        `Remote Super Run ${exact.id} completed without a correlated child run.`,
      );
    }
    const run = await retryRead(
      () =>
        deps.run(runId, AbortSignal.any([signal, AbortSignal.timeout(30_000)])),
      signal,
      sleep,
      `Remote child run read for ${runId} failed`,
    );
    if (run.status === "failed" || run.status === "cancelled") {
      throw new RemoteExecutionFailed(
        `Remote child run ${runId} ${run.status}${run.stop_reason ? ` (${run.stop_reason})` : ""}.`,
      );
    }
    // The Super Run is already terminal here. A requires_approval child is the
    // normal mid-turn boundary; it can be the newest linked run when the
    // listener's later loop frames were lost (e.g. a socket drop), so it must
    // not hold the wait open after Cloud has closed the send.
    if (run.status !== "completed") {
      await sleep(pollMs, signal);
      continue;
    }

    await reportProgress(exact.run_ids, true);
    let messages: Message[] = [];
    try {
      messages = await deps.messages(
        runId,
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      );
    } catch {
      signal.throwIfAborted();
    }
    return {
      text: assistantText(messages) ?? noReplyMessage(receipt),
      runIds: exact.run_ids,
      stopReason: run.stop_reason ?? null,
    };
  }
}
