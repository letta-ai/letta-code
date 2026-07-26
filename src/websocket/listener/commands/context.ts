import {
  buildChannelContextUnavailableMessage,
  buildChannelContextUsageMessage,
} from "@/channels/context-command";
import type { ChannelContextHandler } from "@/channels/registry-handlers";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import type { ListenerRuntime } from "@/websocket/listener/types";
import { getCurrentModelStatusForRuntime } from "./model-toolset";

export function createChannelContextHandler(
  listener: ListenerRuntime,
): ChannelContextHandler {
  return async ({ channelId, runtime }) => {
    const scopedRuntime = getOrCreateScopedRuntime(
      listener,
      runtime.agent_id,
      runtime.conversation_id,
    );

    try {
      const status = await getCurrentModelStatusForRuntime({
        agentId: runtime.agent_id,
        conversationId: runtime.conversation_id,
      });
      return {
        handled: true,
        text: buildChannelContextUsageMessage(channelId, {
          usedTokens: scopedRuntime.contextTracker.lastContextTokens,
          contextWindow: status.contextWindow,
          modelLabel: status.modelLabel,
          scope: status.scope,
        }),
      };
    } catch {
      return {
        handled: true,
        text: buildChannelContextUnavailableMessage(channelId),
      };
    }
  };
}
