// src/agent/check-approval.ts
// Check for pending approvals and retrieve recent message history when resuming an agent/conversation

import { APIError } from "@letta-ai/letta-client/core/error";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  Message,
  MessageType,
} from "@letta-ai/letta-client/resources/agents/messages";
import { getBackend } from "@/backend";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import { debugLog, debugWarn, isDebugEnabled } from "@/utils/debug";

// Backfill should feel like "the last turn(s)", not "the last N raw messages".
// Fetch every renderable message type so the TUI can reconstruct the transcript.
const BACKFILL_PRIMARY_MESSAGE_LIMIT = 10; // user/assistant/reasoning/event/summary
const BACKFILL_MAX_RENDERABLE_MESSAGES = 40; // safety cap

// We fetch more than we render so tool-heavy turns don't push the last
// user-visible assistant message out of the backfill window.
const BACKFILL_PAGE_LIMIT = 50;
const BACKFILL_MIN_ASSISTANT = 1;

const RESUME_BACKFILL_MESSAGE_TYPES: MessageType[] = [
  "user_message",
  "assistant_message",
  "reasoning_message",
  "event_message",
  "summary_message",
  "approval_request_message",
  "tool_return_message",
  "approval_response_message",
];

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
  conversationSummary?: string;
}

export interface GetResumeDataOptions {
  /**
   * Controls whether backfill message history should be fetched.
   * Defaults to true to preserve existing /resume behavior.
   */
  includeMessageHistory?: boolean;
}

type ApprovalMessage = Message & {
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

function approvalRequestsFromMessage(
  messageToCheck: Message,
): ApprovalRequest[] {
  const approvalMsg = messageToCheck as ApprovalMessage;

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
  return toolCalls
    .filter(
      (tc: ToolCallEntry): tc is ToolCallEntry & { tool_call_id: string } =>
        !!tc && !!tc.tool_call_id,
    )
    .map((tc: ToolCallEntry & { tool_call_id: string }) => ({
      toolCallId: tc.tool_call_id,
      toolName: tc.name || "",
      toolArgs: tc.arguments || "",
    }));
}

function logPendingApprovals(pendingApprovals: ApprovalRequest[]): void {
  if (pendingApprovals.length > 0) {
    debugWarn(
      "check-approval",
      `Found ${pendingApprovals.length} pending approval(s): ${pendingApprovals.map((a) => a.toolName).join(", ")}`,
    );
  }
}

/**
 * Extract approval requests from an approval_request_message.
 * Exported for testing parallel tool call handling.
 */
export function extractApprovals(messageToCheck: Message): {
  pendingApproval: ApprovalRequest | null;
  pendingApprovals: ApprovalRequest[];
} {
  const pendingApprovals = approvalRequestsFromMessage(messageToCheck);
  const pendingApproval = pendingApprovals[0] || null;

  logPendingApprovals(pendingApprovals);

  return { pendingApproval, pendingApprovals };
}

function completedToolCallIdsFromMessages(messages: Message[]): Set<string> {
  const completed = new Set<string>();
  for (const message of messages) {
    if (message.message_type === "tool_return_message") {
      const toolReturnMessage = message as Message & {
        tool_call_id?: unknown;
        tool_returns?: Array<{ tool_call_id?: unknown }>;
      };
      if (typeof toolReturnMessage.tool_call_id === "string") {
        completed.add(toolReturnMessage.tool_call_id);
      }
      for (const toolReturn of toolReturnMessage.tool_returns ?? []) {
        if (typeof toolReturn.tool_call_id === "string") {
          completed.add(toolReturn.tool_call_id);
        }
      }
      continue;
    }

    if (message.message_type === "approval_response_message") {
      const approvalResponseMessage = message as Message & {
        approvals?: Array<{ tool_call_id?: unknown }>;
      };
      for (const approval of approvalResponseMessage.approvals ?? []) {
        if (typeof approval.tool_call_id === "string") {
          completed.add(approval.tool_call_id);
        }
      }
    }
  }
  return completed;
}

function pendingApprovalsFromMessageVariants(messages: Message[]): {
  messageToCheck: Message | undefined;
  pendingApproval: ApprovalRequest | null;
  pendingApprovals: ApprovalRequest[];
} {
  const approvalRequests = messages.filter(
    (msg) => msg.message_type === "approval_request_message",
  );
  if (approvalRequests.length === 0) {
    return {
      messageToCheck: messages[0],
      pendingApproval: null,
      pendingApprovals: [],
    };
  }

  const completedToolCallIds = completedToolCallIdsFromMessages(messages);
  const pendingByToolCallId = new Map<string, ApprovalRequest>();
  for (const approvalRequest of approvalRequests) {
    for (const approval of approvalRequestsFromMessage(approvalRequest)) {
      if (completedToolCallIds.has(approval.toolCallId)) continue;
      if (!pendingByToolCallId.has(approval.toolCallId)) {
        pendingByToolCallId.set(approval.toolCallId, approval);
      }
    }
  }
  const pendingApprovals = Array.from(pendingByToolCallId.values());
  const pendingApproval = pendingApprovals[0] || null;
  const latestApprovalRequest =
    approvalRequests[approvalRequests.length - 1] ?? messages[0];

  logPendingApprovals(pendingApprovals);

  return {
    messageToCheck: latestApprovalRequest,
    pendingApproval,
    pendingApprovals,
  };
}

function sourceMessageIdFromVariant(messageId: string): string {
  const variantSeparator = messageId.search(/:(assistant|reasoning|tool):/);
  return variantSeparator >= 0
    ? messageId.slice(0, variantSeparator)
    : messageId;
}

function messageMatchesSourceId(message: Message, sourceId: string): boolean {
  return (
    message.id === sourceId ||
    sourceMessageIdFromVariant(message.id) === sourceId
  );
}

function pendingApprovalsFromTail(
  messages: Message[],
  lastInContextId?: string | null,
): ReturnType<typeof pendingApprovalsFromMessageVariants> {
  if (messages.length === 0) {
    return {
      messageToCheck: undefined,
      pendingApproval: null,
      pendingApprovals: [],
    };
  }

  if (lastInContextId) {
    const variants = messages.filter((message) =>
      messageMatchesSourceId(message, lastInContextId),
    );
    if (variants.length > 0) {
      return pendingApprovalsFromMessageVariants(variants);
    }
    return {
      messageToCheck: undefined,
      pendingApproval: null,
      pendingApprovals: [],
    };
  }

  const latestSourceId = sourceMessageIdFromVariant(
    messages[messages.length - 1]?.id ?? "",
  );
  const latestVariants = latestSourceId
    ? messages.filter((message) =>
        messageMatchesSourceId(message, latestSourceId),
      )
    : [messages[messages.length - 1]].filter((msg): msg is Message => !!msg);
  return pendingApprovalsFromMessageVariants(latestVariants);
}

function tailStartsInsideSourceMessage(
  messages: Message[],
  sourceId: string,
): boolean {
  const firstMessage = messages[0];
  return firstMessage ? messageMatchesSourceId(firstMessage, sourceId) : false;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    ((error as { status?: unknown }).status === 404 ||
      (error as { status?: unknown }).status === 422)
  );
}

async function retrieveMessageVariantsForPendingApproval(
  messageId: string,
): Promise<Message[]> {
  try {
    return await getBackend().retrieveMessage(messageId);
  } catch (error) {
    if (isNotFoundError(error)) {
      debugWarn(
        "check-approval",
        `Unable to retrieve in-context message ${messageId} while checking pending approvals: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
    throw error;
  }
}

/**
 * Prepare message history for backfill, trimming orphaned tool returns.
 * Messages should already be in chronological order (oldest first).
 */
// Exported for tests: resume UX depends on deterministic message-type filtering.
export function prepareMessageHistory(messages: Message[]): Message[] {
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

  // Skip any leading orphaned tool returns (incomplete turn after tail clipping).
  while (messageHistory[0]?.message_type === "tool_return_message") {
    messageHistory = messageHistory.slice(1);
  }

  return messageHistory;
}

/**
 * Sort messages chronologically (oldest first) by date.
 * The API doesn't guarantee order, so we must sort explicitly.
 */
function sortChronological(messages: Message[]): Message[] {
  const messageTypeRank = (messageType: string | undefined): number => {
    switch (messageType) {
      case "user_message":
        return 0;
      case "reasoning_message":
        return 1;
      case "tool_call_message":
      case "approval_request_message":
        return 2;
      case "tool_return_message":
      case "approval_response_message":
        return 3;
      case "assistant_message":
        return 4;
      case "event_message":
        return 5;
      case "summary_message":
        return 6;
      default:
        return 7;
    }
  };

  return [...messages].sort((a, b) => {
    // All message types *should* have 'date', but be defensive.
    const ta = a.date ? new Date(a.date).getTime() : 0;
    const tb = b.date ? new Date(b.date).getTime() : 0;
    if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
    if (!Number.isFinite(ta)) return -1;
    if (!Number.isFinite(tb)) return 1;
    if (ta !== tb) return ta - tb;
    return messageTypeRank(a.message_type) - messageTypeRank(b.message_type);
  });
}

function collectResumeTailMessages(
  tailMessages: Message[],
  options: { warnIfMissingAssistant?: boolean } = {},
): Message[] {
  const seen = new Set<string>();
  let assistantCount = 0;
  const collected: Message[] = [];

  for (const m of tailMessages) {
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
  }

  if (
    options.warnIfMissingAssistant &&
    assistantCount < BACKFILL_MIN_ASSISTANT
  ) {
    debugWarn(
      "check-approval",
      `Backfill scan found 0 assistant messages in last ${collected.length} messages (tool-heavy conversation?)`,
    );
  }

  return sortChronological(collected);
}

async function fetchResumeTail(
  agentId: string,
  conversationId: string,
  limit = BACKFILL_PAGE_LIMIT,
): Promise<{
  conversation?: {
    in_context_message_ids?: string[] | null;
    summary?: string | null;
  };
  messages: Message[];
}> {
  const tail = await getBackend().getConversationResumeTail(
    agentId,
    conversationId,
    {
      limit,
      includeReturnMessageTypes: RESUME_BACKFILL_MESSAGE_TYPES,
    },
  );
  const warnIfMissingAssistant =
    limit >= BACKFILL_PAGE_LIMIT && tail.messages.length >= limit;

  return {
    conversation: tail.conversation,
    messages: collectResumeTailMessages(tail.messages, {
      warnIfMissingAssistant,
    }),
  };
}

async function pendingApprovalsFromTailOrRetrieve(
  messages: Message[],
  lastInContextId?: string | null,
): Promise<ReturnType<typeof pendingApprovalsFromMessageVariants>> {
  const tailCheck = pendingApprovalsFromTail(messages, lastInContextId);
  if (
    lastInContextId &&
    tailCheck.pendingApprovals.length > 0 &&
    tailStartsInsideSourceMessage(messages, lastInContextId)
  ) {
    const retrievedMessages =
      await retrieveMessageVariantsForPendingApproval(lastInContextId);
    return pendingApprovalsFromMessageVariants(retrievedMessages);
  }
  if (tailCheck.messageToCheck || !lastInContextId) return tailCheck;

  const retrievedMessages =
    await retrieveMessageVariantsForPendingApproval(lastInContextId);
  return pendingApprovalsFromMessageVariants(retrievedMessages);
}

/**
 * Gets data needed to resume an agent session.
 * Checks for pending approvals and retrieves recent message history for backfill.
 *
 * The source of truth for pending approvals is `conversation.in_context_message_ids`.
 * We anchor our message fetch to that, not arbitrary recent cursor messages.
 *
 * @param agent - The agent state
 * @param conversationId - Optional conversation ID (uses conversations API)
 * @returns Pending approval (if any) and recent message history
 */
export async function getResumeDataFromBackend(
  agent: AgentState,
  conversationId?: string,
  options: GetResumeDataOptions = {},
): Promise<ResumeData> {
  try {
    const includeMessageHistory = options.includeMessageHistory ?? true;
    const shouldFetchTail = includeMessageHistory && isBackfillEnabled();
    const agentWithInContext = agent as AgentState & {
      in_context_message_ids?: string[] | null;
    };
    const activeConversationId = conversationId ?? "default";
    const useConversationsApi =
      activeConversationId && activeConversationId !== "default";

    let inContextMessageIds: string[] | null | undefined;
    let messages: Message[] = [];
    let conversationSummary: string | undefined;

    if (useConversationsApi) {
      if (shouldFetchTail) {
        try {
          const tail = await fetchResumeTail(agent.id, activeConversationId);
          messages = tail.messages;
          inContextMessageIds = tail.conversation?.in_context_message_ids;
          conversationSummary = tail.conversation?.summary?.trim() || undefined;
        } catch (backfillError) {
          debugWarn(
            "check-approval",
            `Failed to load message history: ${backfillError instanceof Error ? backfillError.message : String(backfillError)}`,
          );
        }
      }

      if (!inContextMessageIds) {
        const conversation =
          await getBackend().retrieveConversation(activeConversationId);
        inContextMessageIds = conversation.in_context_message_ids;
        conversationSummary = conversation.summary?.trim() || undefined;
      }

      const lastInContextId = inContextMessageIds?.at(-1);
      if (!lastInContextId) {
        debugWarn(
          "check-approval",
          "No in-context messages - no pending approvals",
        );
        return {
          pendingApproval: null,
          pendingApprovals: [],
          messageHistory: prepareMessageHistory(messages),
          ...(conversationSummary ? { conversationSummary } : {}),
        };
      }

      const { pendingApproval, pendingApprovals } =
        await pendingApprovalsFromTailOrRetrieve(messages, lastInContextId);
      return {
        pendingApproval,
        pendingApprovals,
        messageHistory: prepareMessageHistory(messages),
        ...(conversationSummary ? { conversationSummary } : {}),
      };
    }

    inContextMessageIds =
      agentWithInContext.in_context_message_ids ?? agent.message_ids;
    const lastInContextId = inContextMessageIds?.at(-1);

    if (shouldFetchTail || !lastInContextId) {
      try {
        const tailLimit = shouldFetchTail ? BACKFILL_PAGE_LIMIT : 1;
        messages = (await fetchResumeTail(agent.id, "default", tailLimit))
          .messages;
        if (isDebugEnabled()) {
          debugLog(
            "check-approval",
            "resume tail(default, agent_id=%s) returned %d messages",
            agent.id,
            messages.length,
          );
        }
      } catch (backfillError) {
        debugWarn(
          "check-approval",
          `Failed to load message history: ${backfillError instanceof Error ? backfillError.message : String(backfillError)}`,
        );
      }
    }

    if (lastInContextId) {
      const { pendingApproval, pendingApprovals } =
        await pendingApprovalsFromTailOrRetrieve(messages, lastInContextId);
      return {
        pendingApproval,
        pendingApprovals,
        messageHistory: prepareMessageHistory(messages),
      };
    }

    if (messages.length === 0) {
      debugWarn(
        "check-approval",
        "No messages in default conversation stream - no pending approvals",
      );
      return {
        pendingApproval: null,
        pendingApprovals: [],
        messageHistory: [],
      };
    }

    const { pendingApproval, pendingApprovals } = pendingApprovalsFromTail(
      messages,
      null,
    );
    return {
      pendingApproval,
      pendingApprovals,
      messageHistory: prepareMessageHistory(messages),
    };
  } catch (error) {
    // Re-throw "not found" errors (404/422) so callers can handle appropriately
    // (e.g., /resume command should fail for non-existent conversations)
    if (error instanceof APIError && isNotFoundError(error)) {
      throw error;
    }
    console.error("Error getting resume data:", error);
    return { pendingApproval: null, pendingApprovals: [], messageHistory: [] };
  }
}
