import { setTimeout as delay } from "node:timers/promises";
import { APIError } from "@letta-ai/letta-client";
import { updateSubagent } from "@/agent/subagent-state.js";
import type { SubagentResult } from "@/agent/subagents";
import { type Backend, getBackend } from "@/backend";
import {
  type EnqueueReceipt,
  getExactSuperRun,
  type LatestConversationSuperRun,
  listEnqueuedRunMessages,
  openConversationStatusStream,
} from "@/backend/api/conversation-enqueue";
import { ApiRequestError } from "@/backend/api/request";
import { buildAgentReference } from "@/cli/helpers/app-urls";
import { INTERRUPTED_BY_USER } from "@/constants";
import { cancelAcceptedListenerInput } from "@/headless-listener-launch";
import { waitForAcceptedSuperRun } from "@/headless-super-run-wait";
import { getErrorMessage } from "@/utils/error";
import { type ExecutionState, processStreamEvent } from "./subagent-stream";

type RemoteResultBackend = Pick<
  Backend,
  "listAgentMessages" | "listConversationMessages" | "retrieveRun"
>;

export interface RemoteResultWaitDeps {
  backend: RemoteResultBackend;
  exact: typeof getExactSuperRun;
  listRunMessages: typeof listEnqueuedRunMessages;
  onMessages?: (
    messages: Awaited<ReturnType<typeof listEnqueuedRunMessages>>,
  ) => void;
  pollMs?: number;
  resultGraceMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface CorrelationScanState {
  after?: string;
  found: boolean;
  closed: boolean;
}

function isTransientRemoteReadError(error: unknown): boolean {
  if (error instanceof ApiRequestError || error instanceof APIError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return (
    error instanceof TypeError ||
    (error instanceof Error && error.name === "TimeoutError")
  );
}

async function retryRemoteRead<T>(
  read: () => Promise<T>,
  signal: AbortSignal,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
): Promise<T> {
  let failures = 0;
  while (true) {
    signal.throwIfAborted();
    try {
      return await read();
    } catch (error) {
      signal.throwIfAborted();
      if (!isTransientRemoteReadError(error)) throw error;
      failures++;
      await sleep(Math.min(1_000 * 2 ** (failures - 1), 10_000), signal);
    }
  }
}

function throwIfAcceptedRunFailed(run: LatestConversationSuperRun): void {
  if (run.errored_at)
    throw new Error(`Remote Super Run ${run.id} finished with an error.`);
  if (run.status === "CAN" || run.cancelled_at)
    throw new Error(`Remote Super Run ${run.id} was cancelled.`);
}

async function scanCorrelatedRunIds(
  receipt: EnqueueReceipt,
  backend: RemoteResultBackend,
  signal: AbortSignal,
  prior: CorrelationScanState,
): Promise<{ runIds: string[]; state: CorrelationScanState }> {
  const runIds = new Set<string>();
  let { after, found, closed } = prior;
  if (closed) return { runIds: [], state: prior };
  while (true) {
    signal.throwIfAborted();
    const query = {
      order: "asc" as const,
      limit: 100,
      include_err: true,
      ...(after ? { after } : {}),
    };
    const page =
      receipt.conversation_id === "default"
        ? await backend.listAgentMessages(
            receipt.agent_id,
            { ...query, conversation_id: "default" },
            { signal },
          )
        : await backend.listConversationMessages(
            receipt.conversation_id,
            query,
            { signal },
          );
    const messages = Array.isArray(page) ? page : page.items;
    for (const message of messages) {
      if (message.message_type === "user_message") {
        if (message.otid === receipt.client_message_id) found = true;
        else if (found) {
          closed = true;
          return {
            runIds: [...runIds],
            state: { after: message.id, found, closed },
          };
        }
      }
      if (!found) continue;
      if (typeof message.run_id === "string" && message.run_id) {
        runIds.add(message.run_id);
      }
    }
    const cursor = messages.at(-1)?.id;
    if (messages.length < 100) {
      return {
        runIds: [...runIds],
        state: { after: cursor ?? after, found, closed },
      };
    }
    if (!cursor || cursor === after) {
      throw new Error("Remote transcript pagination did not advance.");
    }
    after = cursor;
  }
}

/** Recover this accepted send's run IDs from durable transcript history. */
export async function readCorrelatedRunIds(
  receipt: EnqueueReceipt,
  backend: RemoteResultBackend,
  signal: AbortSignal,
): Promise<string[]> {
  return (
    await scanCorrelatedRunIds(receipt, backend, signal, {
      found: false,
      closed: false,
    })
  ).runIds;
}

function assistantText(
  messages: Awaited<ReturnType<typeof listEnqueuedRunMessages>>,
): string | null {
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

/** Require an exact correlated child run and a persisted Agent result. */
export async function waitForCorrelatedRemoteResult(
  receipt: EnqueueReceipt,
  observedRunIds: string[],
  signal: AbortSignal,
  deps: RemoteResultWaitDeps,
): Promise<{ text: string; runIds: string[] }> {
  const runIds = new Set(observedRunIds);
  const now = deps.now ?? Date.now;
  const graceMs = deps.resultGraceMs ?? 15_000;
  const pollMs = deps.pollMs ?? 1_000;
  const sleep =
    deps.sleep ??
    ((ms: number, waitSignal: AbortSignal) =>
      delay(ms, undefined, { signal: waitSignal }));
  const noRunSince = now();
  let completedWithoutText: { runId: string; at: number } | undefined;
  let refreshCorrelation = true;
  let correlationState: CorrelationScanState = {
    found: false,
    closed: false,
  };

  while (true) {
    signal.throwIfAborted();
    const accepted = await retryRemoteRead(
      () =>
        deps.exact(
          receipt.agent_id,
          receipt.super_run_id,
          AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        ),
      signal,
      sleep,
    );
    if (accepted.id !== receipt.super_run_id) {
      throw new Error(
        `Exact Super Run read returned ${accepted.id} for ${receipt.super_run_id}.`,
      );
    }
    throwIfAcceptedRunFailed(accepted);

    if (refreshCorrelation && !correlationState.closed) {
      const scan = await retryRemoteRead(
        () =>
          scanCorrelatedRunIds(receipt, deps.backend, signal, correlationState),
        signal,
        sleep,
      );
      correlationState = scan.state;
      for (const runId of scan.runIds) {
        runIds.add(runId);
      }
      refreshCorrelation = false;
    }

    const runId = [...runIds].at(-1);
    if (!runId) {
      if (now() - noRunSince >= graceMs) {
        throw new Error(
          `Remote Super Run ${receipt.super_run_id} completed without a correlated child run.`,
        );
      }
      refreshCorrelation = true;
      await sleep(pollMs, signal);
      continue;
    }

    const run = await retryRemoteRead(
      () => deps.backend.retrieveRun(runId, { signal }),
      signal,
      sleep,
    );
    if (run.status === "failed" || run.status === "cancelled") {
      throw new Error(
        `Remote run ${runId} ${run.status}${run.stop_reason ? ` (${run.stop_reason})` : ""}`,
      );
    }
    if (run.stop_reason === "requires_approval") {
      refreshCorrelation = true;
      await sleep(pollMs, signal);
      continue;
    }
    if (run.status !== "completed") {
      await sleep(pollMs, signal);
      continue;
    }

    const messages = await retryRemoteRead(
      () => deps.listRunMessages(runId, signal),
      signal,
      sleep,
    );
    deps.onMessages?.(messages);
    const text = assistantText(messages);
    if (text !== null) return { text, runIds: [...runIds] };
    if (completedWithoutText?.runId !== runId) {
      completedWithoutText = { runId, at: now() };
    }
    if (now() - completedWithoutText.at >= graceMs) {
      throw new Error(
        `Remote run ${runId} completed without an assistant reply (${run.stop_reason ?? "unknown stop reason"})`,
      );
    }
    await sleep(pollMs, signal);
  }
}

/** The submitting CLI has exited. The harness follows its Cloud receipt. */
export async function collectRemoteTurnResult(
  receipt: EnqueueReceipt,
  state: ExecutionState,
  subagentId: string,
  signal = new AbortController().signal,
): Promise<SubagentResult> {
  const startedAt = Date.now();
  updateSubagent(subagentId, {
    agentId: receipt.agent_id,
    conversationId: receipt.conversation_id,
    agentURL: buildAgentReference(receipt.agent_id, {
      conversationId: receipt.conversation_id,
    }),
  });
  try {
    const lifecycle = await waitForAcceptedSuperRun(receipt, signal, {
      open: openConversationStatusStream,
      exact: getExactSuperRun,
      // The lifecycle helper also serves fire-and-forget child tracking. Agent
      // success is classified below from the correlated run and result.
      messages: async () => [],
    });
    const seenMessages = new Set<string>();
    const reply = await waitForCorrelatedRemoteResult(
      receipt,
      lifecycle.runIds,
      signal,
      {
        backend: getBackend(),
        exact: getExactSuperRun,
        listRunMessages: listEnqueuedRunMessages,
        onMessages: (messages) => {
          for (const message of messages) {
            if (
              message.message_type === "tool_call_message" &&
              !seenMessages.has(message.id)
            ) {
              seenMessages.add(message.id);
              processStreamEvent(
                JSON.stringify({ type: "message", ...message }),
                state,
                subagentId,
              );
            }
          }
        },
      },
    );
    return {
      agentId: receipt.agent_id,
      conversationId: receipt.conversation_id,
      report: reply.text,
      success: true,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    let detail = getErrorMessage(error);
    if (signal.aborted) {
      const cancelled = await cancelAcceptedListenerInput(receipt).catch(
        () => false,
      );
      detail = cancelled
        ? INTERRUPTED_BY_USER
        : `${INTERRUPTED_BY_USER} (could not confirm cancellation of remote Super Run ${receipt.super_run_id})`;
    }
    return {
      agentId: receipt.agent_id,
      conversationId: receipt.conversation_id,
      report: "",
      success: false,
      error: detail,
      durationMs: Date.now() - startedAt,
    };
  }
}
