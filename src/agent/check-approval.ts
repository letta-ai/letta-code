// src/agent/check-approval.ts
// Check for pending approvals and retrieve recent message history when resuming an agent/conversation

import type Letta from "@letta-ai/letta-client";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { ApprovalRequest } from "../cli/helpers/stream";
import { debugWarn } from "../utils/debug";

// Number of recent messages to backfill when resuming a session
const MESSAGE_HISTORY_LIMIT = 15;

/**
 * Check if message backfilling is enabled via LETTA_BACKFILL env var.
 * Defaults to true. Set LETTA_BACKFILL=0 or LETTA_BACKFILL=false to disable.
 */
function isBackfillEnabled(): boolean {
  const val = process.env.LETTA_BACKFILL;
  // Default to enabled (true) - only disable if explicitly set to "0" or "false"
  return val !== "0" && val !== "false";
}

export interface ResumeData {
  pendingApproval: ApprovalRequest | null; // Deprecated: use pendingApprovals
  pendingApprovals: ApprovalRequest[];
  messageHistory: Message[];
}

/**
 * Gets data needed to resume an agent session.
 * Checks for pending approvals and retrieves recent message history for backfill.
 *
 * The source of truth for pending approvals is `conversation.in_context_message_ids`.
 * We anchor our message fetch to that, not arbitrary recent cursor messages.
 *
 * @param client - The Letta client
 * @param agent - The agent state
 * @param conversationId - Optional conversation ID (uses conversations API)
 * @returns Pending approval (if any) and recent message history
 */
export async function getResumeData(
  client: Letta,
  agent: AgentState,
  conversationId?: string,
): Promise<ResumeData> {
  try {
    let inContextMessageIds: string[] | null | undefined;
    let messages: Message[];

    if (conversationId) {
      // Get conversation to access in_context_message_ids (source of truth)
      const conversation = await client.conversations.retrieve(conversationId);
      inContextMessageIds = conversation.in_context_message_ids;

      if (!inContextMessageIds || inContextMessageIds.length === 0) {
        debugWarn(
          "check-approval",
          "No in-context messages - no pending approvals",
        );
        if (isBackfillEnabled()) {
          const backfill = await client.conversations.messages.list(
            conversationId,
            { limit: MESSAGE_HISTORY_LIMIT },
          );
          return {
            pendingApproval: null,
            pendingApprovals: [],
            messageHistory: backfill,
          };
        }
        return {
          pendingApproval: null,
          pendingApprovals: [],
          messageHistory: [],
        };
      }

      // Fetch messages anchored to in_context_message_ids.
      // By using `after` with the second-to-last in-context message ID,
      // we guarantee the last in-context message is included in results.
      //
      // TODO: Once client.messages.get(messageId) is added to the SDK,
      // replace the workaround below with this simpler approach:
      //
      // ```
      // const lastInContextId = inContextMessageIds[inContextMessageIds.length - 1];
      // const messageToCheck = await client.messages.get(lastInContextId);
      // const messages = isBackfillEnabled()
      //   ? await client.conversations.messages.list(conversationId, { limit: MESSAGE_HISTORY_LIMIT })
      //   : [];
      // ```
      //
      // WORKAROUND: Use pagination to guarantee we fetch the last in-context message.
      if (inContextMessageIds.length >= 2) {
        const anchorId = inContextMessageIds[inContextMessageIds.length - 2];
        debugWarn(
          "check-approval",
          `Fetching messages anchored to: ${anchorId}`,
        );
        messages = await client.conversations.messages.list(conversationId, {
          after: anchorId,
          limit: MESSAGE_HISTORY_LIMIT,
        });
      } else {
        // Only 1 in-context message - fetch recent and find it
        messages = await client.conversations.messages.list(conversationId, {
          limit: MESSAGE_HISTORY_LIMIT,
        });
      }
    } else {
      // Legacy: fall back to agent messages (no conversation ID)
      inContextMessageIds = agent.message_ids;

      if (!inContextMessageIds || inContextMessageIds.length === 0) {
        debugWarn(
          "check-approval",
          "No in-context messages (legacy) - no pending approvals",
        );
        if (isBackfillEnabled()) {
          const messagesPage = await client.agents.messages.list(agent.id, {
            limit: MESSAGE_HISTORY_LIMIT,
          });
          return {
            pendingApproval: null,
            pendingApprovals: [],
            messageHistory: messagesPage.items,
          };
        }
        return {
          pendingApproval: null,
          pendingApprovals: [],
          messageHistory: [],
        };
      }

      // Same anchored fetch approach as conversations path.
      // TODO: Once client.messages.get(messageId) is added to the SDK,
      // simplify to a direct fetch (see TODO in conversations path above).
      if (inContextMessageIds.length >= 2) {
        const anchorId = inContextMessageIds[inContextMessageIds.length - 2];
        debugWarn(
          "check-approval",
          `Fetching agent messages anchored to: ${anchorId}`,
        );
        const messagesPage = await client.agents.messages.list(agent.id, {
          after: anchorId,
          limit: MESSAGE_HISTORY_LIMIT,
        });
        messages = messagesPage.items;
      } else {
        const messagesPage = await client.agents.messages.list(agent.id, {
          limit: MESSAGE_HISTORY_LIMIT,
        });
        messages = messagesPage.items;
      }
    }

    // Find the last in-context message - source of truth for approval state
    // NOTE: There can be multiple messages with the same ID but different types (duplicates).
    // We prefer approval_request_message if it exists, since that's what we're checking for.
    const lastInContextId = inContextMessageIds[inContextMessageIds.length - 1];
    const matchingMessages = messages.filter(
      (msg) => msg.id === lastInContextId,
    );
    const messageToCheck =
      matchingMessages.find(
        (msg) => msg.message_type === "approval_request_message",
      ) ??
      matchingMessages[0] ??
      null;

    if (messageToCheck) {
      debugWarn(
        "check-approval",
        `Found last in-context message: ${messageToCheck.id} (type: ${messageToCheck.message_type})` +
          (matchingMessages.length > 1
            ? ` - had ${matchingMessages.length} duplicates`
            : ""),
      );
    } else {
      debugWarn(
        "check-approval",
        `Last in-context message ${lastInContextId} not found in fetched messages`,
      );
    }

    // Check for pending approval(s)
    let pendingApproval: ApprovalRequest | null = null;
    let pendingApprovals: ApprovalRequest[] = [];

    if (messageToCheck?.message_type === "approval_request_message") {
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

      if (pendingApprovals.length > 0) {
        pendingApproval = pendingApprovals[0] || null;
        debugWarn(
          "check-approval",
          `Found ${pendingApprovals.length} pending approval(s): ${pendingApprovals.map((a) => a.toolName).join(", ")}`,
        );
      }
    }

    // Get message history for backfill
    if (!isBackfillEnabled()) {
      return { pendingApproval, pendingApprovals, messageHistory: [] };
    }

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
