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
