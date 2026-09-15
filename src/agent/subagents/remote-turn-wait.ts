import { updateSubagent } from "@/agent/subagent-state.js";
import type { SubagentResult } from "@/agent/subagents";
import {
  type EnqueueReceipt,
  getLatestConversationSuperRun,
  listEnqueuedRunMessages,
  openConversationStatusStream,
} from "@/backend/api/conversation-enqueue";
import { buildAgentReference } from "@/cli/helpers/app-urls";
import { INTERRUPTED_BY_USER } from "@/constants";
import { cancelAcceptedListenerInput } from "@/headless-listener-launch";
import { waitForAcceptedSuperRun } from "@/headless-super-run-wait";
import { getErrorMessage } from "@/utils/error";
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
    const reply = await waitForAcceptedSuperRun(receipt, signal, {
      open: openConversationStatusStream,
      latest: getLatestConversationSuperRun,
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
