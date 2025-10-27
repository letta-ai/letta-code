// src/agent/check-approval.ts
// Check for pending approvals and retrieve recent message history when resuming an agent

import type Letta from "@letta-ai/letta-client";
import type { LettaMessageUnion } from "@letta-ai/letta-client/resources/agents/messages";
import type { ApprovalRequest } from "../cli/helpers/stream";

// Number of recent messages to backfill when resuming a session
const MESSAGE_HISTORY_LIMIT = 15;

export interface ResumeData {
  pendingApproval: ApprovalRequest | null;
  messageHistory: LettaMessageUnion[];
}

/**
 * Gets data needed to resume an agent session.
 * Checks for pending approvals and retrieves recent message history for backfill.
 *
 * @param client - The Letta client
 * @param agentId - The agent ID
 * @returns Pending approval (if any) and recent message history
 */
export async function getResumeData(
  client: Letta,
  agentId: string,
): Promise<ResumeData> {
  try {
    const messages = await client.agents.messages.list(agentId);
    if (!messages || messages.length === 0) {
      return { pendingApproval: null, messageHistory: [] };
    }

    // Check for pending approval (last message)
    let pendingApproval: ApprovalRequest | null = null;
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.message_type === "approval_request_message") {
      // Use tool_calls array (new) or fallback to tool_call (deprecated)
      const toolCalls = Array.isArray(lastMessage.tool_calls)
        ? lastMessage.tool_calls
        : lastMessage.tool_call
          ? [lastMessage.tool_call]
          : [];

      if (toolCalls.length > 0) {
        const toolCall = toolCalls[0];
        // Ensure all required fields are present (type guard for ToolCall vs ToolCallDelta)
        if (toolCall?.tool_call_id && toolCall.name && toolCall.arguments) {
          pendingApproval = {
            toolCallId: toolCall.tool_call_id,
            toolName: toolCall.name,
            toolArgs: toolCall.arguments,
          };
        }
      }
    }

    // Get last N messages for backfill
    const historyCount = Math.min(MESSAGE_HISTORY_LIMIT, messages.length);
    let messageHistory = messages.slice(-historyCount);

    // Skip if starts with orphaned tool_return (incomplete turn)
    if (messageHistory[0]?.message_type === "tool_return_message") {
      messageHistory = messageHistory.slice(1);
    }

    return { pendingApproval, messageHistory };
  } catch (error) {
    console.error("Error getting resume data:", error);
    return { pendingApproval: null, messageHistory: [] };
  }
}
