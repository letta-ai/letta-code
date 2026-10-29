import { getConversationId, getCurrentAgentId } from "@/agent/context";
import { SYSTEM_REMINDER_OPEN } from "@/constants";
import { getRuntimeContext } from "@/runtime-context";
import { subagentScopeMatches } from "@/utils/subagent-scope";

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
 * Scope: rows are matched with the same matcher the interrupt paths use
 * (subagentScopeMatches), so a notification's "Press Esc to retry" hint is
 * only ever written for rows an Esc can actually reach, and a failure never
 * lands in — or is consumed by — the wrong agent's transcript.
 *
 * Dedup is attempt-qualified via the caller-owned seen set, keyed
 * `${rowId}:${stopAttempt}`: correctness never depends on a render observing
 * the transient in-flight state, so a stop whose dispatch and settlement
 * both land between two renders still re-notifies on failure and still
 * corrects on success. Entries survive scope switches (returning to a scope
 * never replays its failure) and are retired only once the row leaves the
 * snapshot entirely.
 *
 * A "stopped" correction fires only for an outcome the abort hook recorded
 * as a genuine stop (a cancel that killed a still-live run) and only when
 * a failure for an earlier attempt was surfaced, so a normal first-stop
 * and a run that settled on its own mid-retry are never reported as stops.
 */
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

  // Retire entries only for rows that left the snapshot entirely: entries
  // for live rows persist across scope switches so returning to a scope
  // never replays its failure, and terminal rows keep their keys so their
  // correction can never re-fire.
  const present = new Set(rows.map((row) => row.id));
  for (const key of seenIds) {
    const rowId = key.slice(0, key.lastIndexOf(":"));
    if (!present.has(rowId)) {
      seenIds.delete(key);
    }
  }

  return { failures, stops };
}
