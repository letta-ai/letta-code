/**
 * Task Notification Formatting
 *
 * Formats background task completion notifications as XML.
 * The actual queueing is handled by messageQueueBridge.ts.
 */

// ============================================================================
// Types
// ============================================================================

export interface TaskNotification {
  taskId: string;
  status: "completed" | "failed";
  summary: string;
  result: string;
  outputFile: string;
  usage?: {
    totalTokens?: number;
    toolUses?: number;
    durationMs?: number;
  };
}

// ============================================================================
// XML Escaping
// ============================================================================

/**
 * Escape special XML characters to prevent breaking the XML structure.
 */
function escapeXml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXml(str: string): string {
  return str.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Format a single notification as XML string for queueing.
 */
export function formatTaskNotification(notification: TaskNotification): string {
  // Escape summary and result to prevent XML injection
  const escapedSummary = escapeXml(notification.summary);
  const escapedResult = escapeXml(notification.result);

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

  return `<task-notification>
<task-id>${notification.taskId}</task-id>
<status>${notification.status}</status>
<summary>${escapedSummary}</summary>
<result>${escapedResult}</result>${usageBlock}
</task-notification>
Full transcript available at: ${notification.outputFile}`;
}

export function extractTaskNotificationsForDisplay(message: string): {
  notifications: string[];
  cleanedText: string;
} {
  if (!message.includes("<task-notification>")) {
    return { notifications: [], cleanedText: message };
  }

  const notificationRegex =
    /<task-notification>[\s\S]*?(?:<\/task-notification>|$)(?:\s*Full transcript available at:[^\n]*\n?)?/g;
  const notifications: string[] = [];

  let match: RegExpExecArray | null = notificationRegex.exec(message);
  while (match !== null) {
    const xml = match[0];
    const summaryMatch = xml.match(/<summary>([\s\S]*?)<\/summary>/);
    const statusMatch = xml.match(/<status>([\s\S]*?)<\/status>/);
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

// ============================================================================
// Buffer Helpers
// ============================================================================

/**
 * Append task-notification events to a transcript buffer and flush.
 *
 * This is the pure-function core of App.tsx's `appendTaskNotificationEvents`
 * useCallback. Extracting it here makes the behavioral contract testable:
 * buffer writes MUST be followed by a flush so that notifications from
 * background subagent onComplete callbacks (which run outside React's render
 * cycle) appear immediately instead of waiting for the next unrelated render.
 */
export type NotificationBuffer = Pick<
  import("./accumulator").Buffers,
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

/**
 * Format multiple notifications as XML string.
 * @deprecated Use formatTaskNotification and queue individually
 */
export function formatTaskNotifications(
  notifications: TaskNotification[],
): string {
  if (notifications.length === 0) {
    return "";
  }

  return notifications.map(formatTaskNotification).join("\n\n");
}
