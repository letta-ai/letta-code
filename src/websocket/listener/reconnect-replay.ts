/**
 * Reconnect replay — recover and replay pending queued messages after
 * a WebSocket reconnect.  Extracted from lifecycle.ts to keep file size
 * within the project's 1000-line guideline.
 */

import { scheduleQueuePump } from "./queue";
import type { ListenerTransport } from "./transport";
import type {
  ListenerRuntime,
  ProcessQueuedTurn,
  StartListenerOptions,
} from "./types";

/**
 * Recover and replay pending queued messages after reconnect.
 * This ensures in-flight messages that were preserved during disconnect
 * get processed once the connection is re-established.
 */
export function recoverPendingQueuedMessages(
  listener: ListenerRuntime,
  socket: ListenerTransport,
  opts: StartListenerOptions,
  processQueuedTurn: ProcessQueuedTurn,
): void {
  for (const conversationRuntime of listener.conversationRuntimes.values()) {
    // Skip if no queue or queue is empty
    if (
      !conversationRuntime.queueRuntime ||
      conversationRuntime.queueRuntime.isEmpty
    ) {
      continue;
    }

    // Schedule a queue pump to process the preserved items
    scheduleQueuePump(conversationRuntime, socket, opts, processQueuedTurn);
  }
}
