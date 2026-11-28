import type {
  ImageContent,
  LettaAssistantMessageContentUnion,
  LettaUserMessageContentUnion,
  Message,
  TextContent,
} from "@letta-ai/letta-client/resources/agents/messages";
import { stripSystemReminders } from "@/cli/app/system-reminders";
import { extractTaskNotificationsForDisplay } from "@/utils/task-notifications";
import type { Buffers } from "./accumulator";
import { extractCompactionSummary } from "./compaction-utils";
import { trimFinishedReasoningText } from "./reasoning-text";
import { stripSkillContentBlocks } from "./skill-content-display";

function getDisplayableToolReturn(
  content: string | Array<TextContent | ImageContent> | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

const CLIP_CHAR_LIMIT_TEXT = 500;

function clip(s: string, limit: number): string {
  if (!s) return "";
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function removeSystemContextBlocks(text: string): string {
  return stripSkillContentBlocks(stripSystemReminders(text));
}

function renderAssistantContentParts(
  parts: string | LettaAssistantMessageContentUnion[],
): string {
  if (typeof parts === "string") return parts;
  let out = "";
  for (const p of parts) {
    if (p.type === "text") {
      out += p.text || "";
    }
  }
  return out;
}

function renderUserContentParts(
  parts: string | LettaUserMessageContentUnion[],
): string {
  if (typeof parts === "string") {
    const normalized = normalizeLineEndings(parts);
    return clip(removeSystemContextBlocks(normalized), CLIP_CHAR_LIMIT_TEXT);
  }

  const rendered: string[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      const text = p.text || "";
      const normalized = normalizeLineEndings(text);
      const withoutSystemReminders = removeSystemContextBlocks(normalized);
      if (!withoutSystemReminders) continue;
      rendered.push(clip(withoutSystemReminders, CLIP_CHAR_LIMIT_TEXT));
    } else if (p.type === "image") {
      rendered.push("[Image]");
    }
  }
  return rendered.join("\n\n");
}

export function backfillBuffers(buffers: Buffers, history: Message[]): void {
  buffers.order = [];
  buffers.byId.clear();
  buffers.toolCallIdToLineId.clear();
  buffers.pendingToolByRun.clear();
  buffers.userLineIdByOtid.clear();
  buffers.lastOtid = null;
  buffers.assistantCanonicalByMessageId.clear();
  buffers.assistantCanonicalByOtid.clear();
  buffers.reasoningCanonicalByMessageId.clear();
  buffers.reasoningCanonicalByOtid.clear();

  const pendingToolResults = new Map<
    string,
    { resultText: string; resultOk: boolean }
  >();

  const applyToolResult = (
    toolCallId: string,
    result: { resultText: string; resultOk: boolean },
  ) => {
    const toolCallLineId = buffers.toolCallIdToLineId.get(toolCallId);
    if (!toolCallLineId) {
      pendingToolResults.set(toolCallId, result);
      return;
    }

    const existingLine = buffers.byId.get(toolCallLineId);
    if (!existingLine || existingLine.kind !== "tool_call") {
      pendingToolResults.set(toolCallId, result);
      return;
    }

    pendingToolResults.delete(toolCallId);
    buffers.byId.set(toolCallLineId, {
      ...existingLine,
      ...result,
      phase: "finished",
    });
  };

  const applyPendingToolResult = (toolCallId: string) => {
    const pending = pendingToolResults.get(toolCallId);
    if (!pending) return;
    applyToolResult(toolCallId, pending);
  };

  for (const msg of history) {
    const lineId = "otid" in msg && msg.otid ? msg.otid : msg.id;

    switch (msg.message_type) {
      case "user_message": {
        const rawText = renderUserContentParts(msg.content);
        const { notifications, cleanedText } =
          extractTaskNotificationsForDisplay(rawText);

        if (notifications.length > 0) {
          let notifIndex = 0;
          for (const summary of notifications) {
            const notifId = `${lineId}-task-${notifIndex++}`;
            const exists = buffers.byId.has(notifId);
            buffers.byId.set(notifId, {
              kind: "event",
              id: notifId,
              eventType: "task_notification",
              eventData: {},
              phase: "finished",
              summary,
            });
            if (!exists) buffers.order.push(notifId);
          }
        }

        const compactionSummary = extractCompactionSummary(cleanedText);
        if (compactionSummary) {
          const exists = buffers.byId.has(lineId);
          buffers.byId.set(lineId, {
            kind: "event",
            id: lineId,
            eventType: "compaction",
            eventData: {},
            phase: "finished",
            summary: compactionSummary,
          });
          if (!exists) buffers.order.push(lineId);
          break;
        }

        if (cleanedText) {
          const exists = buffers.byId.has(lineId);
          const otid = "otid" in msg ? msg.otid || undefined : undefined;
          buffers.byId.set(lineId, {
            kind: "user",
            id: lineId,
            text: cleanedText,
            messageId: msg.id,
            otid,
          });
          if (otid) {
            buffers.userLineIdByOtid.set(otid, lineId);
          }
          if (!exists) buffers.order.push(lineId);
        }
        break;
      }

      case "reasoning_message": {
        const exists = buffers.byId.has(lineId);
        buffers.byId.set(lineId, {
          kind: "reasoning",
          id: lineId,
          text: trimFinishedReasoningText(msg.reasoning ?? ""),
          phase: "finished",
          messageId: msg.id,
        });
        if (!exists) buffers.order.push(lineId);
        break;
      }

      case "assistant_message": {
        const exists = buffers.byId.has(lineId);
        buffers.byId.set(lineId, {
          kind: "assistant",
          id: lineId,
          text: renderAssistantContentParts(msg.content),
          phase: "finished",
          messageId: msg.id,
        });
        if (!exists) buffers.order.push(lineId);
        break;
      }

      case "tool_call_message":
      case "approval_request_message": {
        const toolCalls = Array.isArray(msg.tool_calls)
          ? msg.tool_calls
          : msg.tool_call
            ? [msg.tool_call]
            : [];

        for (let i = 0; i < toolCalls.length; i++) {
          const toolCall = toolCalls[i];
          if (!toolCall?.tool_call_id) continue;

          const toolCallId = toolCall.tool_call_id;
          if (!toolCallId || !toolCall.name || !toolCall.arguments) continue;

          let uniqueLineId = lineId;

          if (buffers.byId.has(lineId)) {
            const existing = buffers.byId.get(lineId);
            if (existing && existing.kind === "tool_call") {
              uniqueLineId = `${lineId}-${toolCallId.slice(-8)}`;
            }
          }

          const exists = buffers.byId.has(uniqueLineId);

          buffers.byId.set(uniqueLineId, {
            kind: "tool_call",
            id: uniqueLineId,
            toolCallId: toolCallId,
            name: toolCall.name,
            argsText: toolCall.arguments,
            phase: "ready",
          });
          if (!exists) buffers.order.push(uniqueLineId);

          buffers.toolCallIdToLineId.set(toolCallId, uniqueLineId);
          applyPendingToolResult(toolCallId);
        }
        break;
      }

      case "tool_return_message": {
        const toolReturns =
          Array.isArray(msg.tool_returns) && msg.tool_returns.length > 0
            ? msg.tool_returns
            : msg.tool_call_id
              ? [
                  {
                    tool_call_id: msg.tool_call_id,
                    status: msg.status,
                    func_response: msg.tool_return,
                    stdout: msg.stdout,
                    stderr: msg.stderr,
                  },
                ]
              : [];

        for (const toolReturn of toolReturns) {
          const toolCallId = toolReturn.tool_call_id;
          if (!toolCallId) continue;

          const rawResult =
            ("func_response" in toolReturn
              ? toolReturn.func_response
              : undefined) ||
            ("tool_return" in toolReturn
              ? toolReturn.tool_return
              : undefined) ||
            "";
          applyToolResult(toolCallId, {
            resultText: getDisplayableToolReturn(rawResult),
            resultOk: toolReturn.status === "success",
          });
        }
        break;
      }

      case "approval_response_message": {
        const approvals = Array.isArray(msg.approvals) ? msg.approvals : [];
        for (const approval of approvals) {
          if (
            !approval ||
            typeof approval !== "object" ||
            !("tool_call_id" in approval) ||
            typeof approval.tool_call_id !== "string"
          ) {
            continue;
          }

          const isSuccess =
            "type" in approval && approval.type === "tool"
              ? true
              : !("approve" in approval && approval.approve === false);
          const rawResult =
            "tool_return" in approval
              ? approval.tool_return
              : "reason" in approval
                ? approval.reason
                : (msg as { content?: unknown }).content;

          applyToolResult(approval.tool_call_id, {
            resultText: getDisplayableToolReturn(
              rawResult as
                | string
                | Array<TextContent | ImageContent>
                | undefined,
            ),
            resultOk: isSuccess,
          });
        }
        break;
      }

      default: {
        const msgType = msg.message_type as string | undefined;

        if (msgType === "summary_message") {
          const summaryMsg = msg as Message & {
            summary?: string;
            compaction_stats?: {
              trigger?: string;
              context_tokens_before?: number;
              context_tokens_after?: number;
              context_window?: number;
              messages_count_before?: number;
              messages_count_after?: number;
            };
          };

          const summaryText = summaryMsg.summary || "";
          const stats = summaryMsg.compaction_stats;

          for (let i = buffers.order.length - 1; i >= 0; i--) {
            const orderId = buffers.order[i];
            if (!orderId) continue;
            const line = buffers.byId.get(orderId);
            if (line?.kind === "event" && line.eventType === "compaction") {
              line.phase = "finished";
              line.summary = summaryText;
              if (stats) {
                line.stats = {
                  trigger: stats.trigger,
                  contextTokensBefore: stats.context_tokens_before,
                  contextTokensAfter: stats.context_tokens_after,
                  contextWindow: stats.context_window,
                  messagesCountBefore: stats.messages_count_before,
                  messagesCountAfter: stats.messages_count_after,
                };
              }
              break;
            }
          }
          break;
        }

        if (msgType === "event_message") {
          const eventMsg = msg as Message & {
            event_type?: string;
            event_data?: Record<string, unknown>;
          };

          const exists = buffers.byId.has(lineId);
          buffers.byId.set(lineId, {
            kind: "event",
            id: lineId,
            eventType: eventMsg.event_type || "unknown",
            eventData: eventMsg.event_data || {},
            phase: "finished",
          });
          if (!exists) buffers.order.push(lineId);
          break;
        }

        break;
      }
    }
  }

  let foundTransition = false;
  for (let i = buffers.order.length - 1; i >= 0; i--) {
    const lineId = buffers.order[i];
    if (!lineId) continue;
    const line = buffers.byId.get(lineId);

    if (line?.kind === "tool_call" && line.phase === "ready") {
      if (foundTransition) {
        buffers.byId.set(lineId, {
          ...line,
          phase: "finished",
          resultText: "[Tool return not found in history]",
          resultOk: false,
        });
      }
    } else {
      foundTransition = true;
    }
  }
}
