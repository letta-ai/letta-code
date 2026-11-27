import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { getConversationId, getCurrentAgentId } from "@/agent/context";
import {
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
  TASK_NOTIFICATION_CLOSE,
  TASK_NOTIFICATION_OPEN,
} from "@/constants";
import { getRuntimeContext } from "@/runtime-context";
import type { QueuedMessage } from "@/utils/message-queue-bridge";
import { subagentScopeMatches } from "@/utils/subagent-scope";

export interface NotificationScope {
  agentId: string;
  conversationId: string;
  actingUserId?: string | null;
  clientMessageIds?: string[];
}

export interface TaskNotification {
  taskId: string;
  status: "completed" | "failed" | "running";
  summary: string;
  result: string;
  outputFile?: string;
  usage?: {
    totalTokens?: number;
    toolUses?: number;
    durationMs?: number;
  };
}

function escapeXml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXml(str: string): string {
  return str.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function resolveNotificationScope(parentScope?: {
  agentId: string;
  conversationId: string;
}): NotificationScope | undefined {
  const runtime = getRuntimeContext();
  const actingUserId = runtime?.suppressActingUserFallback
    ? null
    : runtime?.actingUserId;
  const clientMessageIds = runtime?.resolveClientMessageIds?.() ?? [];
  const correlation = clientMessageIds.length > 0 ? { clientMessageIds } : {};
  if (parentScope?.agentId) {
    return {
      agentId: parentScope.agentId,
      conversationId: parentScope.conversationId || "default",
      actingUserId,
      ...correlation,
    };
  }

  try {
    return {
      agentId: getCurrentAgentId(),
      conversationId: getConversationId() ?? "default",
      actingUserId,
      ...correlation,
    };
  } catch {
    return undefined;
  }
}

function taskNotificationEnvelope(
  notification: Omit<TaskNotification, "result">,
) {
  const escapedSummary = escapeXml(notification.summary);

  const usageLines: string[] = [];
  if (notification.usage?.totalTokens !== undefined) {
    usageLines.push(`total_tokens: ${notification.usage.totalTokens}`);
  }
  if (notification.usage?.toolUses !== undefined) {
    usageLines.push(`tool_uses: ${notification.usage.toolUses}`);
  }
  if (notification.usage?.durationMs !== undefined) {
    usageLines.push(`duration_ms: ${notification.usage.durationMs}`);
  }
  const usageBlock = usageLines.length
    ? `\n<usage>${usageLines.join("\n")}</usage>`
    : "";

  const transcriptBlock = notification.outputFile
    ? `\n<transcript>${escapeXml(notification.outputFile)}</transcript>`
    : "";

  return {
    open: `${TASK_NOTIFICATION_OPEN}\n<task-id>${escapeXml(notification.taskId)}</task-id>\n<status>${notification.status}</status>\n<summary>${escapedSummary}</summary>\n<result>`,
    close: `</result>${usageBlock}${transcriptBlock}\n${TASK_NOTIFICATION_CLOSE}`,
  };
}

export function formatTaskNotification(notification: TaskNotification): string {
  const { open, close } = taskNotificationEnvelope(notification);
  return `${open}${escapeXml(notification.result)}${close}`;
}

export function formatMultimodalTaskNotification(
  notification: Omit<TaskNotification, "result" | "outputFile">,
  result: Exclude<MessageCreate["content"], string>,
): Exclude<MessageCreate["content"], string> {
  const { open, close } = taskNotificationEnvelope(notification);
  return [
    { type: "text", text: open },
    ...result.map((part) =>
      part.type === "text" ? { ...part, text: escapeXml(part.text) } : part,
    ),
    { type: "text", text: close },
  ];
}

export function subagentResultReminder(): string {
  const reminder = process.env.LETTA_SUBAGENT_RESULT_REMINDER;
  return reminder
    ? `\n\n${SYSTEM_REMINDER_OPEN}\n${reminder}\n${SYSTEM_REMINDER_CLOSE}`
    : "";
}

export function taskNotificationMessage(
  text: string,
): Pick<QueuedMessage, "text" | "content"> {
  const parts = [{ type: "text" as const, text }];
  const reminder = subagentResultReminder();
  if (reminder) parts.push({ type: "text", text: reminder.trimStart() });
  return { text, content: parts };
}

export function formatMonitorEventNotification(notification: {
  taskId: string;
  event: string;
  description?: string;
}): string {
  return `${TASK_NOTIFICATION_OPEN}
<task-id>${escapeXml(notification.taskId)}</task-id>
<summary>${escapeXml(notification.description?.trim() ? `Monitor: ${notification.description}` : "Monitor event")}</summary>
<result>
<event>${escapeXml(notification.event)}</event>
</result>
${TASK_NOTIFICATION_CLOSE}`;
}

export function extractTaskNotificationsForDisplay(message: string): {
  notifications: string[];
  cleanedText: string;
} {
  if (!message.includes(TASK_NOTIFICATION_OPEN)) {
    return { notifications: [], cleanedText: message };
  }

  const notificationRegex =
    /<task-notification>[\s\S]*?(?:<\/task-notification>|$)(?:\s*<external-tool-result>[\s\S]*?<\/external-tool-result>)?(?:\s*Full transcript available at:[^\n]*\n?)?/g;
  const notifications: string[] = [];

  let match: RegExpExecArray | null = notificationRegex.exec(message);
  while (match !== null) {
    const xml = match[0];
    const summaryMatch = xml.match(/<summary>([\s\S]*?)<\/summary>/);
    const statusMatch = xml.match(/<status>([\s\S]*?)<\/status>/);
    const resultMatch = xml.match(/<result>([\s\S]*?)<\/result>/);
    const result = resultMatch?.[1]?.trim() || "";
    const isAgentOnlyReminder = result.includes(SYSTEM_REMINDER_OPEN);
    if (isAgentOnlyReminder) {
      match = notificationRegex.exec(message);
      continue;
    }
    const status = statusMatch?.[1]?.trim();
    let summary = summaryMatch?.[1]?.trim() || "";
    summary = unescapeXml(summary);
    const display = summary || `Agent task ${status || "completed"}`;
    notifications.push(display);
    match = notificationRegex.exec(message);
  }

  const cleanedText = message
    .replace(notificationRegex, "")
    .replace(/^\s*Full transcript available at:[^\n]*\n?/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { notifications, cleanedText };
}

export type NotificationBuffer = Pick<
  import("@/cli/helpers/accumulator").Buffers,
  "byId" | "order"
>;

export function appendTaskNotificationEventsToBuffer(
  summaries: string[],
  buffer: NotificationBuffer,
  generateId: () => string,
  flush?: () => void,
): boolean {
  if (summaries.length === 0) return false;
  for (const summary of summaries) {
    const eventId = generateId();
    buffer.byId.set(eventId, {
      kind: "event",
      id: eventId,
      eventType: "task_notification",
      eventData: {},
      phase: "finished",
      summary,
    });
    buffer.order.push(eventId);
  }
  flush?.();
  return true;
}

export interface StopFailedNotificationSelection {
  failures: string[];
  stops: string[];
}

export function selectStopFailedNotifications(
  rows: Array<{
    id: string;
    description: string;
    status: string;
    stopFailed?: boolean;
    stopOutcome?: {
      attempt: number;
      kind: "failed" | "stopped" | "natural";
    };
    parentAgentId?: string;
    parentConversationId?: string;
  }>,
  seenIds: Set<string>,
  scope: { agentId?: string; conversationId?: string },
): StopFailedNotificationSelection {
  const failures: string[] = [];
  const stops: string[] = [];

  for (const row of rows) {
    if (
      !subagentScopeMatches(row.parentAgentId, row.parentConversationId, scope)
    ) {
      continue;
    }
    if (
      row.stopFailed &&
      (row.status === "pending" || row.status === "running")
    ) {
      const key = `${row.id}:${row.stopOutcome?.attempt ?? 0}`;
      if (!seenIds.has(key)) {
        seenIds.add(key);
        failures.push(
          `Background task "${row.description}" could not be stopped — still running remotely. Press Esc to retry.`,
        );
      }
      continue;
    }
    if (row.stopOutcome?.kind === "stopped" && row.status === "error") {
      const key = `${row.id}:${row.stopOutcome.attempt}`;
      if (!seenIds.has(key)) {
        let surfacedEarlierFailure = false;
        for (let attempt = 0; attempt < row.stopOutcome.attempt; attempt += 1) {
          if (seenIds.has(`${row.id}:${attempt}`)) {
            surfacedEarlierFailure = true;
            break;
          }
        }
        if (surfacedEarlierFailure) {
          seenIds.add(key);
          stops.push(`Background task "${row.description}" stopped.`);
        }
      }
    }
  }

  const present = new Set(rows.map((row) => row.id));
  for (const key of seenIds) {
    const rowId = key.slice(0, key.lastIndexOf(":"));
    if (!present.has(rowId)) {
      seenIds.delete(key);
    }
  }

  return { failures, stops };
}
