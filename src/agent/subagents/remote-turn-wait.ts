import { updateSubagent } from "@/agent/subagent-state.js";
import type { SubagentResult } from "@/agent/subagents";
import { getBackend } from "@/backend";
import {
  type EnqueueReceipt,
  getExactSuperRun,
  listEnqueuedRunMessages,
} from "@/backend/api/conversation-enqueue";
import { buildAgentReference } from "@/cli/helpers/app-urls";
import { INTERRUPTED_BY_USER } from "@/constants";
import { waitForAcceptedSuperRun } from "@/headless-super-run-wait";
import { getErrorMessage } from "@/utils/error";
import { cancelAcceptedRemoteTurn } from "./remote-turn-cancel";
import { type ExecutionState, processStreamEvent } from "./subagent-stream";

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
    const backend = getBackend();
    const reply = await waitForAcceptedSuperRun(receipt, signal, {
      exact: getExactSuperRun,
      run: (runId, readSignal) =>
        backend.retrieveRun(runId, { signal: readSignal }),
      messages: async (runId, readSignal) => {
        const messages = await listEnqueuedRunMessages(runId, readSignal);
        for (const message of messages) {
          if (message.message_type === "tool_call_message") {
            processStreamEvent(
              JSON.stringify({ type: "message", ...message }),
              state,
              subagentId,
            );
          }
        }
        return messages;
      },
    });
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
      const cancellation = await cancelAcceptedRemoteTurn(receipt).catch(
        (cancelError) => ({
          status: "unconfirmed" as const,
          detail: `Remote cancellation unconfirmed for accepted Super Run ${receipt.super_run_id}: ${getErrorMessage(cancelError)}.`,
        }),
      );
      detail =
        cancellation.status === "confirmed"
          ? INTERRUPTED_BY_USER
          : cancellation.detail;
      return {
        agentId: receipt.agent_id,
        conversationId: receipt.conversation_id,
        report: "",
        success: false,
        error: detail,
        durationMs: Date.now() - startedAt,
        remoteCancellation: cancellation,
      };
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
