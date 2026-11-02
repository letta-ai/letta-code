import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { updateSubagent } from "@/agent/subagent-state.js";
import type { SubagentResult } from "@/agent/subagents";
import { getBackend } from "@/backend";
import {
  type EnqueueReceipt,
  getEnqueueAgentId,
  getExactSuperRun,
  listEnqueuedRunMessages,
} from "@/backend/api/conversation-enqueue";
import { buildAgentReference } from "@/cli/helpers/app-urls";
import { INTERRUPTED_BY_USER } from "@/constants";
import { cancelAcceptedListenerInput } from "@/headless-listener-launch";
import {
  type SuperRunWaitDeps,
  waitForAcceptedSuperRun,
} from "@/headless-super-run-wait";
import { recordTaskEvent } from "@/tools/impl/task-transcript";
import { getErrorMessage } from "@/utils/error";
import {
  type ExecutionState,
  processStreamEvent,
  recordToolReturnProgress,
} from "./subagent-stream";

export interface RemoteTurnWaitDeps
  extends Partial<
    Pick<SuperRunWaitDeps, "exact" | "run" | "pollMs" | "progressMs" | "sleep">
  > {
  listMessages?: (runId: string, signal: AbortSignal) => Promise<Message[]>;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && part.type === "text"
        ? String(part.text ?? "")
        : "",
    )
    .join("");
}

/**
 * Record a remote run's tool calls, tool results, reasoning, and assistant
 * text like a local child's stream events, so they reach the subagent state
 * and the task's logs. Each is written once, though runs are re-read while
 * they execute. Client-side tools appear as approval requests.
 */
function recordRemoteRunProgress(
  messages: Message[],
  state: ExecutionState,
  subagentId: string,
): void {
  for (const message of messages) {
    if (
      message.message_type === "tool_call_message" ||
      message.message_type === "approval_request_message"
    ) {
      processStreamEvent(
        JSON.stringify({
          type: "message",
          ...message,
          message_type: "tool_call_message",
        }),
        state,
        subagentId,
      );
    } else if (message.message_type === "tool_return_message") {
      recordToolReturnProgress(message, subagentId);
    } else if (message.message_type === "reasoning_message") {
      recordTaskEvent(
        subagentId,
        { type: "reasoning", text: message.reasoning },
        { at: message.date, key: `${message.id}:reasoning` },
      );
    } else if (message.message_type === "user_message") {
      // A background task the child started (e.g. a long Bash command)
      // reports back as a new turn; its output is often only here.
      const text = messageText(message.content);
      if (text.includes("<task-notification>"))
        recordTaskEvent(
          subagentId,
          { type: "notification", text },
          { at: message.date, key: `${message.id}:notification` },
        );
    } else if (message.message_type === "assistant_message") {
      const text = messageText(message.content);
      recordTaskEvent(
        subagentId,
        { type: "text", text },
        { at: message.date, key: `${message.id}:assistant` },
      );
    }
  }
}

/** The submitting CLI has exited. The harness follows its Cloud receipt. */
export async function collectRemoteTurnResult(
  receipt: EnqueueReceipt,
  state: ExecutionState,
  subagentId: string,
  signal = new AbortController().signal,
  deps: RemoteTurnWaitDeps = {},
): Promise<SubagentResult> {
  const startedAt = Date.now();
  updateSubagent(subagentId, {
    agentId: receipt.agent_id ?? undefined,
    conversationId: receipt.conversation_id,
    agentURL: buildAgentReference(getEnqueueAgentId(receipt), {
      conversationId: receipt.conversation_id,
    }),
  });
  const agentId = getEnqueueAgentId(receipt);
  recordTaskEvent(
    subagentId,
    {
      type: "session",
      ...(agentId ? { agent_id: agentId } : {}),
      conversation_id: receipt.conversation_id,
    },
    { key: `session:${agentId}:${receipt.conversation_id}` },
  );
  try {
    const backend = getBackend();
    const listMessages = deps.listMessages ?? listEnqueuedRunMessages;
    const finishedRuns = new Set<string>();
    const reply = await waitForAcceptedSuperRun(receipt, signal, {
      exact: deps.exact ?? getExactSuperRun,
      run:
        deps.run ??
        ((runId, readSignal) =>
          backend.retrieveRun(runId, { signal: readSignal })),
      messages: async (runId, readSignal) => {
        const messages = await listMessages(runId, readSignal);
        recordRemoteRunProgress(messages, state, subagentId);
        return messages;
      },
      // Stream the remote turn's tool calls and assistant text into the task
      // output file while it runs. A run that has a newer sibling is done, so
      // it is read once more and then skipped.
      onProgress: async (runIds, readSignal) => {
        const [newest] = runIds;
        for (const runId of [...runIds].reverse()) {
          if (finishedRuns.has(runId)) continue;
          recordRemoteRunProgress(
            await listMessages(runId, readSignal),
            state,
            subagentId,
          );
          if (runId !== newest) finishedRuns.add(runId);
        }
      },
      ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
      ...(deps.progressMs !== undefined ? { progressMs: deps.progressMs } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    return {
      agentId: receipt.agent_id ?? "",
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
      agentId: receipt.agent_id ?? "",
      conversationId: receipt.conversation_id,
      report: "",
      success: false,
      error: detail,
      durationMs: Date.now() - startedAt,
    };
  }
}
