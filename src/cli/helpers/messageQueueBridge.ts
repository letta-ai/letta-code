/**
 * Message Queue Bridge
 *
 * Allows non-React code (like Task.ts) to add messages to the messageQueue.
 * The queue adder function is set by App.tsx on mount.
 *
 * This enables background tasks to queue their notification XML directly
 * into messageQueue, where the existing dequeue logic handles auto-firing.
 */

type QueueAdder = (message: string) => void;

let queueAdder: QueueAdder | null = null;
const pendingMessages: string[] = [];
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
export function addToMessageQueue(message: string): void {
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
