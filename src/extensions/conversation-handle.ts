import { sendMessageStreamWithBackend } from "@/agent/message";
import type { Backend } from "@/backend";
import { loadExtensionConversationHistoryFromBackend } from "@/extensions/conversation-history";
import type { ExtensionConversationHandle } from "@/extensions/types";

export function createExtensionConversationHandle(options: {
  agentId?: string | null;
  backend?: Backend;
  conversationId?: string | null;
  workingDirectory?: string | null;
}): ExtensionConversationHandle {
  const conversationId = options.conversationId ?? "default";
  const requireBackend = () => {
    if (!options.backend) {
      throw new Error("Extension conversation backend is not available");
    }
    return options.backend;
  };

  return {
    id: options.conversationId ?? null,
    async fork(forkOptions) {
      const forked = await requireBackend().forkConversation(conversationId, {
        ...(options.agentId ? { agentId: options.agentId } : {}),
        ...forkOptions,
      });
      return createExtensionConversationHandle({
        ...options,
        conversationId: forked.id,
      });
    },
    getHistory(historyOptions) {
      return loadExtensionConversationHistoryFromBackend(
        requireBackend(),
        {
          agentId: options.agentId,
          conversationId,
        },
        historyOptions,
      );
    },
    sendMessageStream(messages, sendOptions, requestOptions) {
      return sendMessageStreamWithBackend(
        requireBackend(),
        conversationId,
        messages,
        {
          ...(options.agentId ? { agentId: options.agentId } : {}),
          ...(options.workingDirectory
            ? { workingDirectory: options.workingDirectory }
            : {}),
          ...sendOptions,
        },
        requestOptions,
      );
    },
  };
}
