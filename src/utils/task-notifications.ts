import { getConversationId, getCurrentAgentId } from "@/agent/context";
import { SYSTEM_REMINDER_OPEN } from "@/constants";
import { getRuntimeContext } from "@/runtime-context";

/**
 * Task Notification Formatting
 *
 * Formats background task completion notifications as XML.
 * The actual queueing is handled by messageQueueBridge.ts.
 */

// ============================================================================
// Types
// ============================================================================

export interface NotificationScope {
  agentId: string;
  conversationId: string;
  actingUserId?: string | null;
}

export interface TaskNotification {
  taskId: string;
  status: "completed" | "failed";
  summary: string;
  result: string;
  outputFile?: string;
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
 * Capture the conversation and initiating sender when background work starts.
 *
 * Prefers the scope injected by executeTool, which is the only correct source
 * in listener/desktop mode where several agent scopes share one process, and
 * falls back to the process-global agent context for plain CLI sessions.
 * Returns undefined when neither is available, in which case the caller should
 * still queue the notification unscoped rather than drop it.
 * Keep this snapshot until delivery; a later turn may belong to another user.
 */
export function resolveNotificationScope(parentScope?: {
  agentId: string;
  conversationId: string;
}): NotificationScope | undefined {
  const runtime = getRuntimeContext();
  const actingUserId = runtime?.suppressActingUserFallback
    ? null
    : runtime?.actingUserId;
  if (parentScope?.agentId) {
    return {
      agentId: parentScope.agentId,
      conversationId: parentScope.conversationId || "default",
      actingUserId,
    };
  }

  try {
    return {
      agentId: getCurrentAgentId(),
      conversationId: getConversationId() ?? "default",
      actingUserId,
    };
  } catch {
    return undefined;
  }
}

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
</task-notification>${notification.outputFile ? `\nFull transcript available at: ${notification.outputFile}` : ""}`;
}

export function formatMonitorEventNotification(notification: {
  taskId: string;
  event: string;
}): string {
  return `<task-notification>
<task-id>${escapeXml(notification.taskId)}</task-id>
<summary>${escapeXml(`Monitor event: "${notification.event}"`)}</summary>
<result>
<event>${escapeXml(notification.event)}</event>
</result>
</task-notification>`;
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
  /** New stop-failure messages for rows entering the surfaced state. */
  failures: string[];
  /** Stop-landed messages for retries the user dispatched from this view. */
  stops: string[];
}

/**
 * Select transcript notifications for subagent rows whose user-requested stop
 * failed (the remote run is still live), and for retries that later landed.
 *
 * Scope: rows are matched against the active agent AND conversation (rows
 * with no recorded parent match any, mirroring the interrupt scoping), so a
 * failure never lands in — or is consumed by — the wrong agent's transcript.
 *
 * Dedup is transition-based via the caller-owned seen set: an id stays in
 * the set only while its row is a live stop-failure in scope, so a failed
 * retry (the row leaves for cancelPending, then restores stopFailed)
 * re-notifies instead of surfacing exactly once. When a surfaced failure's
 * retry is dispatched, the id moves to the caller-owned retrying set; a
 * retry that lands emits a "stopped" correction, a retry that fails is
 * re-notified by the seen-set transition, and a run that settles naturally
 * stays silent (its own completion path owns that message).
 */
export function selectStopFailedNotifications(
  rows: Array<{
    id: string;
    description: string;
    status: string;
    stopFailed?: boolean;
    cancelPending?: boolean;
    parentAgentId?: string;
    parentConversationId?: string;
  }>,
  seenIds: Set<string>,
  retryingIds: Set<string>,
  scope: { agentId?: string; conversationId?: string },
): StopFailedNotificationSelection {
  const failures: string[] = [];
  const stops: string[] = [];
  const liveStopFailed = new Set<string>();

  const matchesScope = (row: {
    parentAgentId?: string;
    parentConversationId?: string;
  }): boolean => {
    if (scope.agentId !== undefined && row.parentAgentId !== undefined) {
      if (row.parentAgentId !== scope.agentId) return false;
    }
    if (
      scope.conversationId !== undefined &&
      row.parentConversationId !== undefined &&
      row.parentConversationId !== scope.conversationId
    ) {
      return false;
    }
    return true;
  };

  for (const row of rows) {
    if (!row.stopFailed) continue;
    if (row.status !== "pending" && row.status !== "running") continue;
    if (!matchesScope(row)) continue;
    liveStopFailed.add(row.id);
    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id);
    failures.push(
      `Background task "${row.description}" could not be stopped — still running remotely. Press Esc to retry.`,
    );
  }

  // Ids whose row left the surfaced state stop consuming the dedupe entry;
  // a row that left because a retry was dispatched is tracked so its
  // outcome can be reported.
  for (const id of seenIds) {
    if (liveStopFailed.has(id)) continue;
    seenIds.delete(id);
    const row = rows.find((candidate) => candidate.id === id);
    if (row?.cancelPending) {
      retryingIds.add(id);
    }
  }

  for (const id of retryingIds) {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row || liveStopFailed.has(id) || row.status === "completed") {
      // Deleted, restored as a fresh failure, or settled naturally: the
      // retry outcome is reported (or owned) elsewhere.
      retryingIds.delete(id);
      continue;
    }
    if (row.status !== "error" || row.cancelPending) continue;
    if (!matchesScope(row)) {
      // The retry landed while another conversation was active: never
      // write this conversation's correction into that transcript.
      retryingIds.delete(id);
      continue;
    }
    retryingIds.delete(id);
    stops.push(`Background task "${row.description}" stopped.`);
  }

  return { failures, stops };
}
