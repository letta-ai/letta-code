import { setTimeout as delay } from "node:timers/promises";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  ConversationStatusEvent,
  EnqueueReceipt,
  LatestConversationSuperRun,
} from "@/backend/api/conversation-enqueue";
import { ApiRequestError } from "@/backend/api/request";
import {
  type EnqueuedReply,
  getConversationStatus,
  getSendRunIds,
} from "@/headless-enqueue-wait";

type StatusEvent =
  | ConversationStatusEvent
  | { type: "super_run_update"; data: LatestConversationSuperRun };
export interface SuperRunWaitDeps {
  open: (
    agentId: string,
    controller: AbortController,
  ) => Promise<AsyncIterable<StatusEvent>>;
  latest: (
    conversationId: string,
    signal: AbortSignal,
  ) => Promise<LatestConversationSuperRun>;
  messages: (runId: string, signal: AbortSignal) => Promise<Message[]>;
  pollMs?: number;
}
class RemoteExecutionFailed extends Error {}

function terminal(run: LatestConversationSuperRun): boolean {
  if (run.status === "CAN" || run.cancelled_at)
    throw new RemoteExecutionFailed(
      `Remote Super Run ${run.id} was cancelled.`,
    );
  if (run.status !== "COM" && !run.completed_at) return false;
  if (run.errored_at)
    throw new RemoteExecutionFailed(
      `Remote Super Run ${run.id} finished with an error.`,
    );
  return true;
}

/** Observe the existing Cloud feed. A lost read never resubmits the task. */
export async function waitForAcceptedSuperRun(
  receipt: EnqueueReceipt,
  signal: AbortSignal,
  deps: SuperRunWaitDeps,
): Promise<EnqueuedReply> {
  const runIds = new Set<string>();
  let finished = false;
  let failures = 0;
  while (!finished) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      // Recover fast completion using the existing latest-send read. A later
      // send's outcome must never be mistaken for this input's outcome.
      if (receipt.conversation_id !== "default") {
        try {
          const latest = await deps.latest(
            receipt.conversation_id,
            AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          );
          if (latest.id === receipt.super_run_id) finished = terminal(latest);
        } catch (error) {
          if (!(error instanceof ApiRequestError && error.status === 404))
            throw error;
        }
      }
      if (finished) break;
      const openTimeout = setTimeout(() => controller.abort(), 30_000);
      const stream = await deps
        .open(receipt.agent_id, controller)
        .finally(() => clearTimeout(openTimeout));
      const events = stream[Symbol.asyncIterator]();
      let next = events.next();
      void next.catch(() => {});
      while (!finished) {
        signal.throwIfAborted();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const event = await Promise.race([
          next,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), deps.pollMs ?? 30_000);
          }),
        ]).finally(() => clearTimeout(timer));
        if (!event) break;
        if (event.done) throw new Error("Cloud status stream disconnected");
        failures = 0;
        const value = event.value;
        if (value.type === "super_run_update") {
          if (value.data.id === receipt.super_run_id)
            finished = terminal(value.data);
        } else {
          const status = getConversationStatus(value, receipt.conversation_id);
          if (status !== undefined) {
            for (const id of getSendRunIds(status, receipt.client_message_id))
              runIds.add(id);
            // The active feed omits finished sends. Its post-acceptance
            // snapshot can end tracking even when detailed results are gone.
            finished = !status?.active_super_runs.some(
              (run) => run.id === receipt.super_run_id,
            );
          }
        }
        if (!finished) {
          next = events.next();
          void next.catch(() => {});
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof RemoteExecutionFailed) throw error;
      if (error instanceof ApiRequestError && [401, 403].includes(error.status))
        throw error;
      await delay(
        Math.min(30_000, (deps.pollMs ?? 1000) * 2 ** Math.min(failures++, 5)),
        undefined,
        { signal },
      );
    } finally {
      signal.removeEventListener("abort", abort);
      controller.abort();
    }
  }
  // The combined idle update can precede the row's terminal update on the
  // same stream. Best-effort read its stored classification before reporting.
  if (receipt.conversation_id !== "default") {
    try {
      const latest = await deps.latest(
        receipt.conversation_id,
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      );
      if (latest.id === receipt.super_run_id) terminal(latest);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof RemoteExecutionFailed) throw error;
    }
  }
  const runId = [...runIds].at(-1);
  if (runId) {
    try {
      const messages = await deps.messages(
        runId,
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      );
      const last = messages
        .filter((m) => m.message_type === "assistant_message")
        .sort((a, b) => (b.seq_id ?? 0) - (a.seq_id ?? 0))[0];
      if (last?.message_type === "assistant_message") {
        const text =
          typeof last.content === "string"
            ? last.content
            : last.content
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("\n");
        if (text.trim()) return { text, runIds: [...runIds], stopReason: null };
      }
    } catch {
      signal.throwIfAborted();
    }
  }
  return {
    text: `Remote task finished. Its reply was not collected. Read the conversation with: letta messages list --agent ${receipt.agent_id} --conversation ${receipt.conversation_id}. Do not launch the task again to retrieve its result.`,
    runIds: [...runIds],
    stopReason: null,
  };
}
