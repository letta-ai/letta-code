/**
 * Message Queue Bridge
 *
 * Allows non-React code (like Task.ts) to add messages to the messageQueue.
 * The queue adder function is set by the active consumer on mount.
 *
 * This enables background tasks to queue their notification XML directly
 * into messageQueue, where the existing dequeue logic handles auto-firing.
 */

export type QueuedMessage = {
  kind: "user" | "task_notification";
  text: string;
  /** Optional parent agent scope for routing in listener mode. */
  agentId?: string;
  /** Optional parent conversation scope for routing in listener mode. */
  conversationId?: string;
};

type QueueAdder = (message: QueuedMessage) => void;

// Global bridge is intentionally single-consumer. Each process runs exactly
// one of: TUI App (App.tsx), headless bidirectional loop, or WebSocket listener.
let queueAdder: QueueAdder | null = null;
const pendingMessages: QueuedMessage[] = [];
const MAX_PENDING_MESSAGES = 10;

/**
 * Set the queue adder function. Called by App.tsx on mount.
 */
export function setMessageQueueAdder(fn: QueueAdder | null): void {
  queueAdder = fn;
  if (queueAdder && pendingMessages.length > 0) {
    for (const message of pendingMessages) {
      queueAdder(message);
    }
    pendingMessages.length = 0;
  }
}

/**
 * Add a message to the messageQueue.
 * Called from Task.ts when a background task completes.
 * If queue adder not set (App not mounted), message is dropped.
 */
export function addToMessageQueue(message: QueuedMessage): void {
  if (queueAdder) {
    queueAdder(message);
    return;
  }
  if (pendingMessages.length >= MAX_PENDING_MESSAGES) {
    pendingMessages.shift();
  }
  pendingMessages.push(message);
}

/**
 * Check if the queue bridge is connected.
 */
export function isQueueBridgeConnected(): boolean {
  return queueAdder !== null;
}

/**
 * Clear any pending messages (for testing).
 */
export function clearPendingMessages(): void {
  pendingMessages.length = 0;
}
