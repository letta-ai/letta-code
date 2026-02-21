// src/agent/check-approval.ts
// Check for pending approvals and retrieve recent message history when resuming an agent/conversation

import type Letta from "@letta-ai/letta-client";
import { APIError } from "@letta-ai/letta-client/core/error";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { ApprovalRequest } from "../cli/helpers/stream";
import { debugWarn } from "../utils/debug";

// Backfill should feel like "the last turn(s)", not "the last N raw messages".
// Tool-heavy turns can generate many tool_call/tool_return messages that would
// otherwise push the most recent assistant/user messages out of the window.
const BACKFILL_PRIMARY_MESSAGE_LIMIT = 12; // user/assistant/reasoning/event/summary
const BACKFILL_MAX_RENDERABLE_MESSAGES = 80; // safety cap

// Note: We intentionally do not include tool-call / tool-return chatter in the
// resume backfill. Pending approvals are handled via `pendingApprovals` and
// shown separately in the UI. Including tool logs here makes resume feel like a
// corrupted replay when the last "turn" was tool-heavy.

// Stop fetching once we have enough actual conversational anchors.
// Reasoning can be extremely tool-step heavy, so anchor on user/assistant.
const BACKFILL_ANCHOR_MESSAGE_LIMIT = 6;

// We fetch more than we render so tool-heavy turns don't push the last
// user-visible assistant message out of the backfill window.
const BACKFILL_PAGE_LIMIT = 200;
const BACKFILL_MAX_PAGES = 25; // 5k messages max
const BACKFILL_MIN_ASSISTANT = 1;

function isPrimaryMessageType(messageType: string | undefined): boolean {
  return (
    messageType === "user_message" ||
    messageType === "assistant_message" ||
    messageType === "event_message" ||
    messageType === "summary_message"
  );
}

function isAnchorMessageType(messageType: string | undefined): boolean {
  return messageType === "user_message" || messageType === "assistant_message";
}

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
// Exported for tests: resume UX depends on strict message-type filtering.
export function prepareMessageHistory(
  messages: Message[],
  opts?: { primaryOnly?: boolean },
): Message[] {
  const isRenderable = (msg: Message): boolean => {
    const t = msg.message_type;
    if (
      t === "user_message" ||
      t === "assistant_message" ||
      t === "reasoning_message" ||
      t === "tool_call_message" ||
      t === "tool_return_message" ||
      t === "approval_request_message" ||
      t === "approval_response_message"
    ) {
      return true;
    }
    // Newer servers may include extra message types (event/summary) that we render in backfill.
    const ts = t as string | undefined;
    return ts === "event_message" || ts === "summary_message";
  };

  const renderable = messages.filter(isRenderable);
  if (opts?.primaryOnly) {
    // Resume view should prioritize the actual conversation (user/assistant + events).
    // Reasoning can be extremely tool-step heavy and will crowd out assistant messages.
    const convo = renderable.filter((m) =>
      isPrimaryMessageType(m.message_type),
    );
    let trimmed = convo.slice(-BACKFILL_PRIMARY_MESSAGE_LIMIT);

    // Hardening: if the last N items are all user/system-y content, ensure we
    // still include the most recent assistant message when one exists.
    const hasAssistant = trimmed.some(
      (m) => m.message_type === "assistant_message",
    );
    if (!hasAssistant) {
      const lastAssistantIndex = convo
        .map((m) => m.message_type)
        .lastIndexOf("assistant_message");
      if (lastAssistantIndex >= 0) {
        const start = Math.max(
          0,
          lastAssistantIndex - (BACKFILL_PRIMARY_MESSAGE_LIMIT - 1),
        );
        trimmed = convo.slice(start, start + BACKFILL_PRIMARY_MESSAGE_LIMIT);
      }
    }
    if (trimmed.length > 0) return trimmed;

    // If we have no user/assistant/event/summary (rare), fall back to reasoning.
    // If reasoning is also absent, show a small tail of whatever renderable
    // messages exist so resume isn't blank.
    const reasoning = renderable.filter(
      (m) => m.message_type === "reasoning_message",
    );
    if (reasoning.length > 0) {
      return reasoning.slice(-BACKFILL_PRIMARY_MESSAGE_LIMIT);
    }
    // Last resort: show a small reasoning-only slice.
    // Do not fall back to tool chatter.
    return [];
  }

  // Walk backwards until we've captured enough "primary" messages to anchor
  // the replay (user/assistant/reasoning + high-level events), but include tool
  // messages in-between so the last turn still makes sense.
  const isPrimary = (msg: Message): boolean => {
    const t = msg.message_type;
    return (
      t === "user_message" ||
      t === "assistant_message" ||
      t === "reasoning_message" ||
      (t as string | undefined) === "event_message" ||
      (t as string | undefined) === "summary_message"
    );
  };

  let primaryCount = 0;
  let startIndex = Math.max(0, renderable.length - 1);
  for (let i = renderable.length - 1; i >= 0; i -= 1) {
    const msg = renderable[i];
    if (!msg) continue;
    if (isPrimary(msg)) {
      primaryCount += 1;
      if (primaryCount >= BACKFILL_PRIMARY_MESSAGE_LIMIT) {
        startIndex = i;
        break;
      }
    }
    startIndex = i;
  }

  let messageHistory = renderable.slice(startIndex);
  if (messageHistory.length > BACKFILL_MAX_RENDERABLE_MESSAGES) {
    messageHistory = messageHistory.slice(-BACKFILL_MAX_RENDERABLE_MESSAGES);
  }

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
    // All message types *should* have 'date', but be defensive.
    const ta = a.date ? new Date(a.date).getTime() : 0;
    const tb = b.date ? new Date(b.date).getTime() : 0;
    if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
    if (!Number.isFinite(ta)) return -1;
    if (!Number.isFinite(tb)) return 1;
    return ta - tb;
  });
}

async function fetchConversationBackfillMessages(
  client: Letta,
  conversationId: string,
): Promise<Message[]> {
  const collected: Message[] = [];
  // Messages can have multiple variants with the same id (e.g. approval_request + reasoning).
  // Dedupe using a key that preserves distinct variants while still preventing
  // overlap across pagination pages.
  const seen = new Set<string>();

  let cursorBefore: string | null = null;
  let assistantCount = 0;
  let anchorCount = 0;

  for (let pageIndex = 0; pageIndex < BACKFILL_MAX_PAGES; pageIndex += 1) {
    const page = await client.conversations.messages.list(conversationId, {
      limit: BACKFILL_PAGE_LIMIT,
      order: "desc",
      ...(cursorBefore ? { before: cursorBefore } : {}),
    });
    const items = page.getPaginatedItems();
    if (items.length === 0) break;

    // items are newest->oldest; use the last item as our "before" cursor.
    cursorBefore = items[items.length - 1]?.id ?? null;

    for (const m of items) {
      if (!m?.id) continue;

      // Prefer otid when available (it is unique across variants). Otherwise,
      // include message_type to avoid dropping variants that share ids.
      const key =
        "otid" in m && (m as { otid?: unknown }).otid
          ? `otid:${String((m as { otid?: unknown }).otid)}`
          : `id:${m.id}:${m.message_type ?? ""}`;

      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(m);

      if (m.message_type === "assistant_message") assistantCount += 1;
      if (isAnchorMessageType(m.message_type)) anchorCount += 1;
    }

    // Stop once we can confidently show a good recent slice.
    if (
      assistantCount >= BACKFILL_MIN_ASSISTANT &&
      anchorCount >= BACKFILL_ANCHOR_MESSAGE_LIMIT
    ) {
      break;
    }

    // If the server returned fewer than requested, we're likely at the end.
    if (items.length < BACKFILL_PAGE_LIMIT) break;
  }

  if (assistantCount < BACKFILL_MIN_ASSISTANT) {
    debugWarn(
      "check-approval",
      `Backfill scan found 0 assistant messages in last ${collected.length} messages (tool-heavy conversation?)`,
    );
  }

  return sortChronological(collected);
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
            const backfill = await fetchConversationBackfillMessages(
              client,
              conversationId,
            );
            return {
              pendingApproval: null,
              pendingApprovals: [],
              messageHistory: prepareMessageHistory(backfill, {
                primaryOnly: true,
              }),
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
          messages = await fetchConversationBackfillMessages(
            client,
            conversationId,
          );
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
            messageHistory: prepareMessageHistory(messages, {
              primaryOnly: true,
            }),
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
        messageHistory: prepareMessageHistory(messages, { primaryOnly: true }),
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
            limit: BACKFILL_PAGE_LIMIT,
            order: "desc",
            conversation_id: "default", // Key: filter to default conversation only
          });
          messages = sortChronological(messagesPage.items);

          if (process.env.DEBUG) {
            console.log(
              `[DEBUG] agents.messages.list(conversation_id=default) returned ${messages.length} messages`,
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
            messageHistory: prepareMessageHistory(messages, {
              primaryOnly: true,
            }),
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
        messageHistory: prepareMessageHistory(messages, { primaryOnly: true }),
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
