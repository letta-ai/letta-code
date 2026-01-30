// src/agent/check-approval.ts
// Check for pending approvals and retrieve recent message history when resuming an agent/conversation

import type Letta from "@letta-ai/letta-client";
import { APIError } from "@letta-ai/letta-client/core/error";
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
 * Extract approval requests from an approval_request_message.
 * Exported for testing parallel tool call handling.
 */
export function extractApprovals(messageToCheck: Message): {
  pendingApproval: ApprovalRequest | null;
  pendingApprovals: ApprovalRequest[];
} {
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
  const pendingApprovals = toolCalls
    .filter(
      (tc: ToolCallEntry): tc is ToolCallEntry & { tool_call_id: string } =>
        !!tc && !!tc.tool_call_id,
    )
    .map((tc: ToolCallEntry & { tool_call_id: string }) => ({
      toolCallId: tc.tool_call_id,
      toolName: tc.name || "",
      toolArgs: tc.arguments || "",
    }));

  const pendingApproval = pendingApprovals[0] || null;

  if (pendingApprovals.length > 0) {
    debugWarn(
      "check-approval",
      `Found ${pendingApprovals.length} pending approval(s): ${pendingApprovals.map((a) => a.toolName).join(", ")}`,
    );
  }

  return { pendingApproval, pendingApprovals };
}

/**
 * Prepare message history for backfill, trimming orphaned tool returns.
 * Messages should already be in chronological order (oldest first).
 */
function prepareMessageHistory(messages: Message[]): Message[] {
  const historyCount = Math.min(MESSAGE_HISTORY_LIMIT, messages.length);
  let messageHistory = messages.slice(-historyCount);

  // Skip if starts with orphaned tool_return (incomplete turn)
  if (messageHistory[0]?.message_type === "tool_return_message") {
    messageHistory = messageHistory.slice(1);
  }

  return messageHistory;
}

/**
 * Sort messages chronologically (oldest first) by date.
 * The API doesn't guarantee order, so we must sort explicitly.
 */
function sortChronological(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => {
    // All message types have 'date' field
    const dateA = a.date ?? "";
    const dateB = b.date ?? "";
    return new Date(dateA).getTime() - new Date(dateB).getTime();
  });
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
    let messages: Message[] = [];

    // Use conversations API for explicit conversations,
    // use agents API for "default" or no conversationId (agent's primary message history)
    const useConversationsApi = conversationId && conversationId !== "default";

    if (process.env.DEBUG) {
      console.log(
        `[DEBUG] getResumeData: conversationId=${conversationId}, useConversationsApi=${useConversationsApi}, agentId=${agent.id}`,
      );
    }

    if (useConversationsApi) {
      // Get conversation to access in_context_message_ids (source of truth)
      const conversation = await client.conversations.retrieve(conversationId);
      inContextMessageIds = conversation.in_context_message_ids;

      if (!inContextMessageIds || inContextMessageIds.length === 0) {
        debugWarn(
          "check-approval",
          "No in-context messages - no pending approvals",
        );
        if (isBackfillEnabled()) {
          try {
            const backfill = await client.conversations.messages.list(
              conversationId,
              {
                limit: MESSAGE_HISTORY_LIMIT,
                order: "desc",
                // @ts-expect-error - SDK MessageListParams doesn't include this yet
                include_compaction_messages: true,
              },
            );
            return {
              pendingApproval: null,
              pendingApprovals: [],
              messageHistory: sortChronological(backfill.getPaginatedItems()),
            };
          } catch (backfillError) {
            debugWarn(
              "check-approval",
              `Failed to load message history: ${backfillError instanceof Error ? backfillError.message : String(backfillError)}`,
            );
          }
        }
        return {
          pendingApproval: null,
          pendingApprovals: [],
          messageHistory: [],
        };
      }

      // Fetch the last in-context message directly by ID
      // (We already checked inContextMessageIds.length > 0 above)
      const lastInContextId = inContextMessageIds.at(-1);
      if (!lastInContextId) {
        throw new Error("Expected at least one in-context message");
      }
      const retrievedMessages = await client.messages.retrieve(lastInContextId);

      // Fetch message history separately for backfill (desc then reverse for last N chronological)
      // Wrapped in try/catch so backfill failures don't crash the CLI
      if (isBackfillEnabled()) {
        try {
          const backfillPage = await client.conversations.messages.list(
            conversationId,
            {
              limit: MESSAGE_HISTORY_LIMIT,
              order: "desc",
              // @ts-expect-error - SDK MessageListParams doesn't include this yet
              include_compaction_messages: true,
            },
          );
          messages = sortChronological(backfillPage.getPaginatedItems());
        } catch (backfillError) {
          debugWarn(
            "check-approval",
            `Failed to load message history: ${backfillError instanceof Error ? backfillError.message : String(backfillError)}`,
          );
        }
      }

      // Find the approval_request_message variant if it exists
      // (A single DB message can have multiple content types returned as separate Message objects)
      const messageToCheck =
        retrievedMessages.find(
          (msg) => msg.message_type === "approval_request_message",
        ) ?? retrievedMessages[0];

      if (messageToCheck) {
        debugWarn(
          "check-approval",
          `Found last in-context message: ${messageToCheck.id} (type: ${messageToCheck.message_type})` +
            (retrievedMessages.length > 1
              ? ` - had ${retrievedMessages.length} variants`
              : ""),
        );

        // Check for pending approval(s) inline since we already have the message
        if (messageToCheck.message_type === "approval_request_message") {
          const { pendingApproval, pendingApprovals } =
            extractApprovals(messageToCheck);
          return {
            pendingApproval,
            pendingApprovals,
            messageHistory: prepareMessageHistory(messages),
          };
        }
      } else {
        debugWarn(
          "check-approval",
          `Last in-context message ${lastInContextId} not found via retrieve`,
        );
      }

      return {
        pendingApproval: null,
        pendingApprovals: [],
        messageHistory: prepareMessageHistory(messages),
      };
    } else {
      // Use agent messages API for "default" conversation or when no conversation ID
      // (agent's primary message history without explicit conversation isolation)
      inContextMessageIds = agent.message_ids;

      if (!inContextMessageIds || inContextMessageIds.length === 0) {
        debugWarn(
          "check-approval",
          "No in-context messages (default/agent API) - no pending approvals",
        );
        // No in-context messages = empty default conversation, don't show random history
        return {
          pendingApproval: null,
          pendingApprovals: [],
          messageHistory: [],
        };
      }

      // Fetch the last in-context message directly by ID
      // (We already checked inContextMessageIds.length > 0 above)
      const lastInContextId = inContextMessageIds.at(-1);
      if (!lastInContextId) {
        throw new Error("Expected at least one in-context message");
      }
      const retrievedMessages = await client.messages.retrieve(lastInContextId);

      // Fetch message history for backfill using conversation_id=default
      // This filters to only the default conversation's messages (like the ADE does)
      // Wrapped in try/catch so backfill failures don't crash the CLI (e.g., older servers
      // may not support conversation_id filter)
      if (isBackfillEnabled()) {
        try {
          const messagesPage = await client.agents.messages.list(agent.id, {
            limit: MESSAGE_HISTORY_LIMIT,
            order: "desc",
            conversation_id: "default", // Key: filter to default conversation only
            // @ts-expect-error - SDK MessageListParams doesn't include this yet
            include_compaction_messages: true,
          });
          messages = sortChronological(messagesPage.items);

          if (process.env.DEBUG) {
            console.log(
              `[DEBUG] agents.messages.list(conversation_id=default) returned ${messagesPage.items.length} messages`,
            );
          }
        } catch (backfillError) {
          debugWarn(
            "check-approval",
            `Failed to load message history: ${backfillError instanceof Error ? backfillError.message : String(backfillError)}`,
          );
        }
      }

      // Find the approval_request_message variant if it exists
      const messageToCheck =
        retrievedMessages.find(
          (msg) => msg.message_type === "approval_request_message",
        ) ?? retrievedMessages[0];

      if (messageToCheck) {
        debugWarn(
          "check-approval",
          `Found last in-context message: ${messageToCheck.id} (type: ${messageToCheck.message_type})` +
            (retrievedMessages.length > 1
              ? ` - had ${retrievedMessages.length} variants`
              : ""),
        );

        if (messageToCheck.message_type === "approval_request_message") {
          const { pendingApproval, pendingApprovals } =
            extractApprovals(messageToCheck);
          return {
            pendingApproval,
            pendingApprovals,
            messageHistory: prepareMessageHistory(messages),
          };
        }
      } else {
        debugWarn(
          "check-approval",
          `Last in-context message ${lastInContextId} not found via retrieve (default/agent API)`,
        );
      }

      return {
        pendingApproval: null,
        pendingApprovals: [],
        messageHistory: prepareMessageHistory(messages),
      };
    }
  } catch (error) {
    // Re-throw "not found" errors (404/422) so callers can handle appropriately
    // (e.g., /resume command should fail for non-existent conversations)
    if (
      error instanceof APIError &&
      (error.status === 404 || error.status === 422)
    ) {
      throw error;
    }
    console.error("Error getting resume data:", error);
    return { pendingApproval: null, pendingApprovals: [], messageHistory: [] };
  }
}
