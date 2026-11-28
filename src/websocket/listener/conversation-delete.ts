import type { Backend } from "@/backend";
import { ConversationBusyError } from "@/backend/conversation-busy-error";
import {
  conversationRuntimeHasPendingWork,
  getActiveRuntime,
  removeConversationRuntime,
} from "./runtime";
import type { ListenerRuntime } from "./types";

const BUSY_RETRY_INTERVAL_MS = 100;
export const EPHEMERAL_CONVERSATION_DELETE_WAIT_MS = 60_000;

export interface DeleteConversationFromListenerOptions {
  listener?: ListenerRuntime | null;
  waitForIdleMs?: number;
}

export async function deleteConversationFromListener(
  backend: Backend,
  conversationId: string,
  options: DeleteConversationFromListenerOptions = {},
): Promise<void> {
  const deadline = Date.now() + (options.waitForIdleMs ?? 0);
  for (;;) {
    try {
      await deleteIdleConversation(
        backend,
        conversationId,
        options.listener ?? getActiveRuntime(),
      );
      return;
    } catch (error) {
      if (!(error instanceof ConversationBusyError) || Date.now() >= deadline) {
        throw error;
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, BUSY_RETRY_INTERVAL_MS);
      (timer as { unref?: () => void }).unref?.();
    });
  }
}

async function deleteIdleConversation(
  backend: Backend,
  conversationId: string,
  listener: ListenerRuntime | null,
): Promise<void> {
  if (!backend.deleteConversation) {
    throw new Error("Deleting conversations is not supported by this backend");
  }
  const runtimes = listener
    ? [...listener.conversationRuntimes.values()].filter(
        (runtime) => runtime.conversationId === conversationId,
      )
    : [];
  if (runtimes.some(conversationRuntimeHasPendingWork)) {
    throw new ConversationBusyError(
      `Conversation ${conversationId} is busy in this listener; wait for it to go idle before deleting it`,
    );
  }
  await backend.deleteConversation(conversationId);
  for (const runtime of runtimes) {
    removeConversationRuntime(runtime);
  }
}
