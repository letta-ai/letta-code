// Parent-side tracking of a computer-routed subagent turn.
//
// The child process only submits the send (`--no-wait`) and exits with the
// enqueue receipt. This module then follows the remote turn through Cloud's
// super-run status stream and run APIs until Cloud reports a reply or reports
// that the send ended without one. There is no wall-clock ceiling: a dropped
// status stream or a failed HTTP read is reopened after a backoff, because the
// remote turn keeps running regardless of what this process observes.

import { setTimeout as delay } from "node:timers/promises";
import type {
  Message,
  Run,
} from "@letta-ai/letta-client/resources/agents/messages";
import { updateSubagent } from "@/agent/subagent-state.js";
import type { SubagentResult } from "@/agent/subagents";
import { getBackend } from "@/backend";
import {
  type ConversationStatusEvent,
  dequeueConversationMessage,
  type EnqueueReceipt,
  getLatestConversationSuperRun,
  type LatestConversationSuperRun,
  listEnqueuedRunMessages,
  openConversationStatusStream,
} from "@/backend/api/conversation-enqueue";
import { buildAgentReference } from "@/cli/helpers/app-urls";
import { INTERRUPTED_BY_USER } from "@/constants";
import {
  type EnqueuedReply,
  EnqueuedWaitError,
  waitForEnqueuedReply,
} from "@/headless-enqueue-wait";
import { debugWarn } from "@/utils/debug";
import { getErrorMessage } from "@/utils/error";
import { type ExecutionState, processStreamEvent } from "./subagent-stream";

export interface RemoteTurnWaitDeps {
  openStatusStream: (
    agentId: string,
    controller: AbortController,
  ) => Promise<AsyncIterable<ConversationStatusEvent>>;
  retrieveRun: (runId: string, signal: AbortSignal) => Promise<Run>;
  listRunMessages: (runId: string, signal: AbortSignal) => Promise<Message[]>;
  latestSuperRun: (
    conversationId: string,
    signal: AbortSignal,
  ) => Promise<LatestConversationSuperRun | null>;
  /** Delay between reconnect attempts; grows to `maxReconnectDelayMs`. */
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  /** Interval for run/super-run polls while the stream is quiet. */
  pollMs?: number;
  now?: () => number;
}

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_POLL_MS = 5_000;
const READ_TIMEOUT_MS = 30_000;

export class RemoteTurnAbortedError extends Error {
  constructor() {
    super("Remote turn tracking aborted");
    this.name = "RemoteTurnAbortedError";
  }
}

/**
 * Follow a computer-routed send until Cloud reports its reply.
 *
 * Exits only when: the reply is available; Cloud reports the send ended
 * without a reply (`EnqueuedWaitError` whose cause is
 * `SendEndedWithoutReplyError`); or `signal` aborts (`RemoteTurnAbortedError`).
 * Transport loss (closed SSE stream, failed HTTP read) reopens the stream and
 * keeps the run IDs already mapped to this send.
 */
export async function waitForRemoteTurnReply(
  params: { receipt: EnqueueReceipt; signal: AbortSignal },
  deps: RemoteTurnWaitDeps,
): Promise<EnqueuedReply> {
  const { receipt, signal } = params;
  const runIds = new Set<string>();
  const baseDelay = deps.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const maxDelay = deps.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
  let attempt = 0;

  const read = <T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> =>
    operation(AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]));

  while (true) {
    if (signal.aborted) throw new RemoteTurnAbortedError();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const events = (
        await deps.openStatusStream(receipt.agent_id, controller)
      )[Symbol.asyncIterator]();
      const first = await events.next();
      if (first.done)
        throw new Error(
          "Conversation status connection closed before its snapshot",
        );
      attempt = 0;
      return await waitForEnqueuedReply({
        receipt,
        events,
        firstEvent: first.value,
        runIds,
        signal,
        pollMs: deps.pollMs ?? DEFAULT_POLL_MS,
        now: deps.now,
        retrieveRun: (runId) => read((s) => deps.retrieveRun(runId, s)),
        listRunMessages: (runId) => read((s) => deps.listRunMessages(runId, s)),
        latestSuperRun: () =>
          receipt.conversation_id === "default"
            ? Promise.resolve(null)
            : read((s) => deps.latestSuperRun(receipt.conversation_id, s)),
      });
    } catch (error) {
      if (signal.aborted) throw new RemoteTurnAbortedError();
      if (error instanceof EnqueuedWaitError && error.sendEnded) throw error;
      // Anything else is transport: the stream closed, a read timed out, or
      // Cloud answered with a transient failure. The remote turn is unaffected.
      attempt += 1;
      const wait = Math.min(
        maxDelay,
        baseDelay * 2 ** Math.min(attempt - 1, 10),
      );
      debugWarn(
        "subagent",
        `Remote turn ${receipt.super_run_id} (conversation ${receipt.conversation_id}): status tracking lost (${getErrorMessage(error)}); reconnecting in ${wait}ms (attempt ${attempt}, ${runIds.size} run(s) known)`,
      );
      await delay(wait, undefined, { signal }).catch(() => {});
    } finally {
      signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }
}

/**
 * Follow a computer-routed subagent send until Cloud reports its reply.
 * Records the run's tool calls afterwards so the task notification's counts
 * stay meaningful without a live stream from the remote listener.
 */
export async function collectRemoteTurnResult(
  receipt: EnqueueReceipt,
  state: ExecutionState,
  subagentId: string,
  signal?: AbortSignal,
): Promise<SubagentResult> {
  const backend = getBackend();
  const startedAt = Date.now();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  state.agentId ||= receipt.agent_id;
  state.conversationId ||= receipt.conversation_id;
  updateSubagent(subagentId, {
    agentId: receipt.agent_id,
    agentURL: buildAgentReference(receipt.agent_id, {
      conversationId: receipt.conversation_id,
    }),
    conversationId: receipt.conversation_id,
  });
  try {
    const reply = await waitForRemoteTurnReply(
      { receipt, signal: controller.signal },
      {
        openStatusStream: openConversationStatusStream,
        retrieveRun: (runId, s) => backend.retrieveRun(runId, { signal: s }),
        listRunMessages: listEnqueuedRunMessages,
        latestSuperRun: getLatestConversationSuperRun,
      },
    );
    for (const runId of reply.runIds) {
      try {
        const messages = await listEnqueuedRunMessages(
          runId,
          AbortSignal.timeout(30_000),
        );
        processRemoteRunMessages(messages, state, subagentId);
      } catch (error) {
        debugWarn(
          "subagent",
          `Could not list messages for remote run ${runId}: ${getErrorMessage(error)}`,
        );
      }
    }
    return {
      agentId: receipt.agent_id,
      conversationId: receipt.conversation_id,
      report: reply.text,
      success: true,
      stepCount: reply.runIds.length,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof RemoteTurnAbortedError) {
      // Best effort: remove the send if it is still queued. A turn already
      // executing on the remote computer keeps running; say so.
      const dequeued = await dequeueConversationMessage(
        {
          agentId: receipt.agent_id,
          conversationId: receipt.conversation_id,
          clientMessageId: receipt.client_message_id,
        },
        AbortSignal.timeout(10_000),
      ).catch(() => null);
      const stillRunning = dequeued?.status !== "dequeued";
      return {
        agentId: receipt.agent_id,
        conversationId: receipt.conversation_id,
        report: "",
        success: false,
        error: stillRunning
          ? `${INTERRUPTED_BY_USER} (remote turn ${receipt.super_run_id} may still be running on the target computer)`
          : INTERRUPTED_BY_USER,
      };
    }
    return {
      agentId: receipt.agent_id,
      conversationId: receipt.conversation_id,
      report: "",
      success: false,
      error: getErrorMessage(error),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Record the remote run's tool calls so the subagent's tool-call list is populated. */
function processRemoteRunMessages(
  messages: Message[],
  state: ExecutionState,
  subagentId: string,
): void {
  for (const message of messages) {
    if (message.message_type !== "tool_call_message") continue;
    processStreamEvent(
      JSON.stringify({ type: "message", ...message }),
      state,
      subagentId,
    );
  }
}
