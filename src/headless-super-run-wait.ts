import { setTimeout as delay } from "node:timers/promises";
import { APIError } from "@letta-ai/letta-client";
import type {
  Message,
  Run,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { AgentRuntimeStatusEntry } from "@/backend/api/agents";
import {
  type EnqueueReceipt,
  type ExactSuperRun,
  getEnqueueAgentId,
} from "@/backend/api/conversation-enqueue";
import { ApiRequestError } from "@/backend/api/request";
import type { EnqueuedReply } from "@/headless-enqueue-wait";

/**
 * Follow the recipient conversation after its Super Run closes. A remote turn
 * can end while background work it started is still running; that work's
 * completion notification starts a later turn holding the real answer.
 */
export interface ConversationSettleDeps {
  /** The conversation's runtime status, or null when the route is unavailable. */
  status: (signal: AbortSignal) => Promise<AgentRuntimeStatusEntry | null>;
  /** The conversation's most recent messages, newest first. */
  messages: (signal: AbortSignal) => Promise<Message[]>;
  maxWaitMs: number;
  pollMs?: number;
  now?: () => number;
}

export interface SuperRunWaitDeps {
  exact: (
    agentId: string,
    superRunId: string,
    signal: AbortSignal,
  ) => Promise<ExactSuperRun>;
  run: (runId: string, signal: AbortSignal) => Promise<Run>;
  messages: (runId: string, signal: AbortSignal) => Promise<Message[]>;
  /** Wait for background work and return the final reply. Omit for lifecycle-only waits. */
  settle?: ConversationSettleDeps;
  pollMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

class RemoteExecutionFailed extends Error {}

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

function noReplyMessage(
  receipt: EnqueueReceipt,
  status = "Remote task finished. Its reply was not collected.",
): string {
  return `${status} Read the conversation with: letta messages list --agent ${getEnqueueAgentId(receipt)} --conversation ${receipt.conversation_id}. Do not launch the task again to retrieve its result.`;
}

/** No turn, queued input, or background work (Bash, Monitor, Workflow, subagent) remains. */
function isConversationSettled(status: AgentRuntimeStatusEntry): boolean {
  if (
    (status.active_bash_count ?? 0) > 0 ||
    (status.active_monitor_count ?? 0) > 0 ||
    (status.active_workflow_count ?? 0) > 0 ||
    status.has_active_background_subagents === true
  )
    return false;
  if (status.state === "IDLE") return true;
  return (
    status.state === "ACTIVE" &&
    status.loop_state?.status === "WAITING_ON_INPUT" &&
    (status.queue?.length ?? 0) === 0 &&
    status.active_run_ids.length === 0
  );
}

/** Newest assistant text written after the accepted send's own run. */
function laterAssistantText(
  messages: Message[],
  sendRunIds: string[],
  sendMessages: Message[],
): string | null {
  const sendMessageIds = new Set(sendMessages.map((message) => message.id));
  const sendSeqIds = sendMessages.flatMap((message) =>
    typeof message.seq_id === "number" ? [message.seq_id] : [],
  );
  const lastSendSeqId = sendSeqIds.length ? Math.max(...sendSeqIds) : null;
  for (const message of messages) {
    if (
      sendMessageIds.has(message.id) ||
      (message.run_id && sendRunIds.includes(message.run_id)) ||
      (lastSendSeqId !== null &&
        typeof message.seq_id === "number" &&
        message.seq_id <= lastSendSeqId)
    )
      return null;
    if (message.message_type === "assistant_message") {
      const text = assistantText([message]);
      if (text) return text;
    }
  }
  return null;
}

async function followUntilSettled(
  receipt: EnqueueReceipt,
  reply: EnqueuedReply,
  sendMessages: Message[],
  signal: AbortSignal,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  deps: ConversationSettleDeps,
): Promise<EnqueuedReply> {
  const now = deps.now ?? Date.now;
  const deadline = now() + deps.maxWaitMs;
  const followSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(deps.maxWaitMs),
  ]);
  const read = <T>(
    operation: (signal: AbortSignal) => Promise<T>,
    within = followSignal,
  ) =>
    retryRead(
      () => operation(AbortSignal.any([within, AbortSignal.timeout(30_000)])),
      within,
      sleep,
      `Remote conversation read for ${receipt.conversation_id} failed`,
    );
  const latestText = async (within = followSignal) =>
    laterAssistantText(
      await read(deps.messages, within),
      reply.runIds,
      sendMessages,
    ) ?? reply.text;
  const minutes = Math.round(deps.maxWaitMs / 60_000);
  let unsettled = `The remote task was still running background work after ${minutes} minute(s); the reply above may not be final.`;
  try {
    while (true) {
      const before = await read(deps.status);
      // Older servers without runtime status keep the send's own reply.
      if (!before) return reply;
      if (isConversationSettled(before)) {
        const text = await latestText();
        // Confirm nothing started while the messages were read.
        const after = await read(deps.status);
        if (
          !after ||
          (isConversationSettled(after) &&
            after.last_activity_at === before.last_activity_at)
        )
          return { ...reply, text };
      }
      if (now() >= deadline) break;
      await sleep(deps.pollMs ?? 2_000, followSignal);
    }
  } catch {
    signal.throwIfAborted();
    // A failed follow-up read must not discard the reply already collected.
    if (!followSignal.aborted)
      unsettled =
        "Could not confirm that the remote task finished its background work; the reply above may not be final.";
  }
  let latest = reply.text;
  try {
    latest = await latestText(
      AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    );
  } catch {
    signal.throwIfAborted();
  }
  return {
    ...reply,
    text: `${latest}\n\n${noReplyMessage(receipt, unsettled)}`,
  };
}

/** Follow the exact accepted send. Reads may retry; the task is never resubmitted. */
export async function waitForAcceptedSuperRun(
  receipt: EnqueueReceipt,
  signal: AbortSignal,
  deps: SuperRunWaitDeps,
): Promise<EnqueuedReply> {
  const pollMs = deps.pollMs ?? 1_000;
  const sleep =
    deps.sleep ??
    ((ms: number, waitSignal: AbortSignal) =>
      delay(ms, undefined, { signal: waitSignal }));

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
      await sleep(pollMs, signal);
      continue;
    }

    const runId = exact.run_ids[0];
    if (!runId) {
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

    let messages: Message[] = [];
    try {
      messages = await deps.messages(
        runId,
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      );
    } catch {
      signal.throwIfAborted();
    }
    const reply = {
      text: assistantText(messages) ?? noReplyMessage(receipt),
      runIds: exact.run_ids,
      stopReason: run.stop_reason ?? null,
    };
    // The Super Run only links the turn that consumed this send. A background
    // task's completion notification wakes the recipient for a later turn
    // that is not linked to it, so the final answer can live there.
    return deps.settle
      ? followUntilSettled(receipt, reply, messages, signal, sleep, deps.settle)
      : reply;
  }
}
