// Sidebar "waiting for your answer" tracking for AskUserQuestionAsync
// receipts. Registration happens when an approved batch's persisted results
// include a successful question receipt; clearing happens when a user message
// carrying the answer/dismissal notification is dispatched into a turn.

import type { ApprovalResult } from "@/agent/approval-execution";
import {
  parseAskUserQuestionNotif,
  parseAskUserQuestionReceipt,
} from "@/ask-user-question";
import { getInternalToolName } from "@/tools/tool-name-mapping";
import type { ConversationRuntime } from "./types";

/**
 * Add tool call IDs of successfully executed AskUserQuestionAsync calls to
 * the runtime's pending set. `decisions` and `results` are parallel approval
 * pipeline artifacts: decisions carry the server-facing tool name, results
 * carry the receipt by tool_call_id.
 */
export function registerPendingAsyncQuestions(
  runtime: ConversationRuntime,
  decisions: Array<{ approval: { toolCallId: string; toolName: string } }>,
  results: ApprovalResult[],
): void {
  const resultsByToolCallId = new Map<string, ApprovalResult>();
  for (const result of results) {
    if ("tool_call_id" in result && typeof result.tool_call_id === "string") {
      resultsByToolCallId.set(result.tool_call_id, result);
    }
  }
  for (const decision of decisions) {
    if (
      getInternalToolName(decision.approval.toolName) !== "AskUserQuestionAsync"
    ) {
      continue;
    }
    const result = resultsByToolCallId.get(decision.approval.toolCallId);
    if (!result || !("tool_return" in result) || result.status !== "success") {
      continue;
    }
    const receipt = parseAskUserQuestionReceipt(result.tool_return);
    if (receipt?.toolCallId === decision.approval.toolCallId) {
      runtime.pendingAsyncQuestionToolCallIds.add(receipt.toolCallId);
    }
  }
}

/** Extract user-visible text from an incoming message's user-role entries. */
export function extractIncomingMessageText(
  messages: ReadonlyArray<Record<string, unknown>>,
): string {
  const parts: string[] = [];
  for (const message of messages) {
    // ApprovalCreate entries have no `content` field.
    if (!("content" in message)) continue;
    const content = message.content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (
          part !== null &&
          typeof part === "object" &&
          "type" in part &&
          (part as { type: unknown }).type === "text" &&
          "text" in part &&
          typeof (part as { text: unknown }).text === "string"
        ) {
          parts.push((part as { text: string }).text);
        }
      }
    }
  }
  return parts.join("\n");
}

/**
 * Remove tool call IDs whose answer/dismissal notification is carried by an
 * incoming user message. Both answered and dismissed clear the indicator.
 */
export function clearPendingAsyncQuestionsFromMessage(
  runtime: ConversationRuntime,
  messages: ReadonlyArray<Record<string, unknown>>,
): void {
  if (runtime.pendingAsyncQuestionToolCallIds.size === 0) return;
  const text = extractIncomingMessageText(messages);
  if (!text) return;
  for (const response of parseAskUserQuestionNotif(text)) {
    runtime.pendingAsyncQuestionToolCallIds.delete(response.toolCallId);
  }
}
