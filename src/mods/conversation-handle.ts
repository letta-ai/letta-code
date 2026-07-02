import { updateModelConfig } from "@/agent/modify";
import type { Backend } from "@/backend";
import { loadModConversationHistoryFromBackend } from "@/mods/conversation-history";
import type {
  ModConversationHandle,
  ModConversationMessage,
  ModConversationSendMessageOptions,
  ModConversationSendMessageRequestOptions,
  ModUpdateLlmConfigOptions,
} from "@/mods/types";

type SendModConversationMessageStream = (
  backend: Backend,
  conversationId: string,
  messages: ModConversationMessage[],
  options?: ModConversationSendMessageOptions & { agentId?: string },
  requestOptions?: ModConversationSendMessageRequestOptions,
) => ReturnType<ModConversationHandle["sendMessageStream"]>;

export function createModConversationHandle(options: {
  agentId?: string | null;
  backend?: Backend;
  conversationId?: string | null;
  sendMessageStream: SendModConversationMessageStream;
  workingDirectory?: string | null;
}): ModConversationHandle {
  const conversationId = options.conversationId ?? "default";
  const requireBackend = () => {
    if (!options.backend) {
      throw new Error("Mod conversation backend is not available");
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
      return createModConversationHandle({
        ...options,
        conversationId: forked.id,
      });
    },
    getHistory(historyOptions) {
      return loadModConversationHistoryFromBackend(
        requireBackend(),
        {
          agentId: options.agentId,
          conversationId,
        },
        historyOptions,
      );
    },
    sendMessageStream(messages, sendOptions, requestOptions) {
      return options.sendMessageStream(
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
    async updateLlmConfig(update: ModUpdateLlmConfigOptions) {
      const backend = requireBackend();
      const { scope, ...config } = update;
      if (scope === "agent") {
        if (!options.agentId) {
          throw new Error(
            "Mod updateLlmConfig: agentId is not available for an agent-scope update",
          );
        }
        await updateModelConfig(
          backend,
          { scope: "agent", agentId: options.agentId },
          config,
        );
        return;
      }
      await updateModelConfig(
        backend,
        { scope: "conversation", conversationId, agentId: options.agentId },
        config,
      );
    },
  };
}
