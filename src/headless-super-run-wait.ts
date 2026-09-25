import { setTimeout as delay } from "node:timers/promises";
import { APIError } from "@letta-ai/letta-client";
import type {
  Message,
  Run,
} from "@letta-ai/letta-client/resources/agents/messages";
import type {
  EnqueueReceipt,
  ExactSuperRun,
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
  pollMs?: number;
  resultGraceMs?: number;
  now?: () => number;
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

function noReplyMessage(receipt: EnqueueReceipt): string {
  return `Remote task finished. Its reply was not collected. Read the conversation with: letta messages list --agent ${receipt.agent_id} --conversation ${receipt.conversation_id}. Do not launch the task again to retrieve its result.`;
}

/** Follow the exact accepted send. Reads may retry; the task is never resubmitted. */
export async function waitForAcceptedSuperRun(
  receipt: EnqueueReceipt,
  signal: AbortSignal,
  deps: SuperRunWaitDeps,
): Promise<EnqueuedReply> {
  const pollMs = deps.pollMs ?? 1_000;
  const resultGraceMs = deps.resultGraceMs ?? 15_000;
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((ms: number, waitSignal: AbortSignal) =>
      delay(ms, undefined, { signal: waitSignal }));
  let missingResultSince: number | undefined;

  while (true) {
    signal.throwIfAborted();
    const exact = await retryRead(
      () =>
        deps.exact(
          receipt.agent_id,
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
    if (run.status !== "completed" || run.stop_reason === "requires_approval") {
      missingResultSince ??= now();
      if (now() - missingResultSince >= resultGraceMs) {
        throw new RemoteExecutionFailed(
          `Remote Super Run ${exact.id} completed without terminal evidence from child run ${runId}.`,
        );
      }
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
    return {
      text: assistantText(messages) ?? noReplyMessage(receipt),
      runIds: exact.run_ids,
      stopReason: run.stop_reason ?? null,
    };
  }
}
