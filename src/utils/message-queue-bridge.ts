import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";

export type QueuedMessage = {
  kind: "user" | "task_notification";
  text: string;
  content?: MessageCreate["content"];
  source?: "cron";
  agentId?: string;
  conversationId?: string;
  actingUserId?: string | null;
  clientMessageIds?: string[];
  queueItemId?: string;
  paused?: boolean;
};

type QueueAdder = (message: QueuedMessage) => void;

let queueAdder: QueueAdder | null = null;
const pendingMessages: QueuedMessage[] = [];
const MAX_PENDING_MESSAGES = 10;

export function setMessageQueueAdder(fn: QueueAdder | null): void {
  queueAdder = fn;
  if (queueAdder && pendingMessages.length > 0) {
    for (const message of pendingMessages) {
      queueAdder(message);
    }
    pendingMessages.length = 0;
  }
}

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

export function isQueueBridgeConnected(): boolean {
  return queueAdder !== null;
}

export function clearPendingMessages(): void {
  pendingMessages.length = 0;
}
