// src/agent/check-approval.ts
// Check for pending approvals and retrieve recent message history when resuming an agent

import type Letta from "@letta-ai/letta-client";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
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
 * @param agent - The agent state (includes in-context messages)
 * @returns Pending approval (if any) and recent message history
 */
export async function getResumeData(
  client: Letta,
  agent: AgentState,
): Promise<ResumeData> {
  try {
    const messagesPage = await client.agents.messages.list(agent.id);
    const messages = messagesPage.items;
    if (!messages || messages.length === 0) {
      return { pendingApproval: null, messageHistory: [] };
    }

    // Compare cursor last message with in-context last message ID
    // The backend uses in-context messages for CONFLICT validation, so if they're
    // desynced, we need to check the in-context message for pending approvals
    const cursorLastMessage = messages[messages.length - 1];
    if (!cursorLastMessage) {
      return { pendingApproval: null, messageHistory: [] };
    }

    const inContextLastMessageId =
      agent.message_ids && agent.message_ids.length > 0
        ? agent.message_ids[agent.message_ids.length - 1]
        : null;

    let messageToCheck = cursorLastMessage;

    // If there's a desync, find the in-context message in the cursor fetch
    if (
      inContextLastMessageId &&
      cursorLastMessage.id !== inContextLastMessageId
    ) {
      console.warn(
        `[check-approval] Desync detected - cursor last: ${cursorLastMessage.id}, in-context last: ${inContextLastMessageId}`,
      );

      // Search for the in-context message in the fetched messages
      // NOTE: There might be multiple messages with the same ID (duplicates)
      // We want the one with role === "approval" if it exists
      const matchingMessages = messages.filter(
        (msg) => msg.id === inContextLastMessageId,
      );

      if (matchingMessages.length > 0) {
        // Prefer the approval request message if it exists (duplicates can have different types)
        const approvalMessage = matchingMessages.find(
          (msg) => msg.message_type === "approval_request_message",
        );
        const inContextMessage =
          approvalMessage ?? matchingMessages[matchingMessages.length - 1]!;

        messageToCheck = inContextMessage;
      } else {
        console.warn(
          `[check-approval] In-context message ${inContextLastMessageId} not found in cursor fetch.\n` +
            `  This likely means the in-context message is older than the cursor window.\n` +
            `  Falling back to cursor message - approval state may be incorrect.`,
        );
        // Fall back to cursor message if we can't find the in-context one
      }
    }

    // Check for pending approval using SDK types
    let pendingApproval: ApprovalRequest | null = null;

    if (messageToCheck.message_type === "approval_request_message") {
      // Cast to access tool_calls with proper typing
      const approvalMsg = messageToCheck as LettaMessageUnion & {
        tool_calls?: Array<{
          tool_call_id?: string;
          name?: string;
          arguments?: string;
        }>;
        tool_call?: {
          tool_call_id?: string;
          name?: string;
          arguments?: string;
        };
      };

      // Use tool_calls array (new) or fallback to tool_call (deprecated)
      const toolCalls = Array.isArray(approvalMsg.tool_calls)
        ? approvalMsg.tool_calls
        : approvalMsg.tool_call
          ? [approvalMsg.tool_call]
          : [];

      if (toolCalls.length > 0) {
        const toolCall = toolCalls[0];
        // Ensure all required fields are present
        if (toolCall?.tool_call_id && toolCall.name && toolCall.arguments) {
          pendingApproval = {
            toolCallId: toolCall.tool_call_id,
            toolName: toolCall.name,
            toolArgs: toolCall.arguments,
          };
        }
      }
    }

    // Get last N messages for backfill (always use cursor messages for history)
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
