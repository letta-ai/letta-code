// src/agent/check-approval.ts
// Check for pending approvals and retrieve recent message history when resuming an agent

import type Letta from "@letta-ai/letta-client";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { ApprovalRequest } from "../cli/helpers/stream";

// Number of recent messages to backfill when resuming a session
const MESSAGE_HISTORY_LIMIT = 15;

export interface ResumeData {
  pendingApproval: ApprovalRequest | null; // Deprecated: use pendingApprovals
  pendingApprovals: ApprovalRequest[];
  messageHistory: Message[];
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
      return {
        pendingApproval: null,
        pendingApprovals: [],
        messageHistory: [],
      };
    }

    // Compare cursor last message with in-context last message ID
    // The backend uses in-context messages for CONFLICT validation, so if they're
    // desynced, we need to check the in-context message for pending approvals
    const cursorLastMessage = messages[messages.length - 1];
    if (!cursorLastMessage) {
      return {
        pendingApproval: null,
        pendingApprovals: [],
        messageHistory: [],
      };
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
        `[check-approval] Desync detected:\n` +
          `  cursor last: ${cursorLastMessage.id} (type: ${cursorLastMessage.message_type})\n` +
          `  in-context last: ${inContextLastMessageId} (type: unknown until found)`,
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
        const lastMessage = matchingMessages[matchingMessages.length - 1];
        const inContextMessage = approvalMessage ?? lastMessage;

        if (inContextMessage) {
          console.warn(
            `[check-approval] Found in-context message (type: ${inContextMessage.message_type})` +
              (matchingMessages.length > 1
                ? ` - had ${matchingMessages.length} duplicates`
                : ""),
          );
          messageToCheck = inContextMessage;
        }
      } else {
        console.warn(
          `[check-approval] In-context message ${inContextLastMessageId} not found in cursor fetch.\n` +
            `  This likely means the in-context message is older than the cursor window.\n` +
            `  Falling back to cursor message - approval state may be incorrect.`,
        );
        // Fall back to cursor message if we can't find the in-context one
      }
    }

    // Check for pending approval(s) using SDK types
    let pendingApproval: ApprovalRequest | null = null;
    let pendingApprovals: ApprovalRequest[] = [];

    // Log the agent's last_stop_reason for debugging
    const lastStopReason = (agent as { last_stop_reason?: string })
      .last_stop_reason;
    if (lastStopReason === "requires_approval") {
      console.warn(
        `[check-approval] Agent last_stop_reason: ${lastStopReason}`,
      );
      console.warn(
        `[check-approval] Message to check: ${messageToCheck.id} (type: ${messageToCheck.message_type})`,
      );
    }

    if (messageToCheck.message_type === "approval_request_message") {
      // Cast to access tool_calls with proper typing
      const approvalMsg = messageToCheck as Message & {
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

      // Extract ALL tool calls for parallel approval support
      // Include ALL tool_call_ids, even those with incomplete name/arguments
      // Incomplete entries will be denied at the business logic layer
      type ToolCallEntry = {
        tool_call_id?: string;
        name?: string;
        arguments?: string;
      };
      pendingApprovals = toolCalls
        .filter(
          (tc: ToolCallEntry): tc is ToolCallEntry & { tool_call_id: string } =>
            !!tc && !!tc.tool_call_id,
        )
        .map((tc: ToolCallEntry & { tool_call_id: string }) => ({
          toolCallId: tc.tool_call_id,
          toolName: tc.name || "",
          toolArgs: tc.arguments || "",
        }));

      // Set legacy singular field for backward compatibility (first approval only)
      if (pendingApprovals.length > 0) {
        pendingApproval = pendingApprovals[0] || null;
        console.warn(
          `[check-approval] Found ${pendingApprovals.length} pending approval(s): ${pendingApprovals.map((a) => a.toolName).join(", ")}`,
        );
      }
    }

    // Get last N messages for backfill (always use cursor messages for history)
    const historyCount = Math.min(MESSAGE_HISTORY_LIMIT, messages.length);
    let messageHistory = messages.slice(-historyCount);

    // Skip if starts with orphaned tool_return (incomplete turn)
    if (messageHistory[0]?.message_type === "tool_return_message") {
      messageHistory = messageHistory.slice(1);
    }

    return { pendingApproval, pendingApprovals, messageHistory };
  } catch (error) {
    console.error("Error getting resume data:", error);
    return { pendingApproval: null, pendingApprovals: [], messageHistory: [] };
  }
}
