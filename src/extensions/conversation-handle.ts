import type {
  ExtensionConversationHandle,
  ExtensionRuntimeBackendApi,
} from "@/extensions/types";

export function createExtensionConversationHandle(options: {
  agentId?: string | null;
  backend?: ExtensionRuntimeBackendApi;
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
      return requireBackend().getConversationHistory(conversationId, {
        ...(options.agentId ? { agentId: options.agentId } : {}),
        ...historyOptions,
      });
    },
    sendMessageStream(messages, sendOptions, requestOptions) {
      return requireBackend().sendMessageStream(
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
