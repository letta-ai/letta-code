import { buildChannelCompactFailedMessage } from "@/channels/compact-command";
import type { ChannelCompactHandler } from "@/channels/registry-handlers";
import { debugWarn } from "@/utils/debug";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import type { ListenerTransport } from "@/websocket/listener/transport";
import type { ListenerRuntime } from "@/websocket/listener/types";
import {
  CompactBlockedError,
  CompactUsageError,
  runCompactCommand,
} from "./compact-core";

export function createChannelCompactHandler(
  listener: ListenerRuntime,
  socket: ListenerTransport,
): ChannelCompactHandler {
  return async ({ channelId, runtime, args }) => {
    const scopedRuntime = getOrCreateScopedRuntime(
      listener,
      runtime.agent_id,
      runtime.conversation_id,
    );

    try {
      return {
        handled: true,
        text: await runCompactCommand({
          socket,
          conversationRuntime: scopedRuntime,
          args,
        }),
      };
    } catch (error) {
      if (
        error instanceof CompactUsageError ||
        error instanceof CompactBlockedError
      ) {
        return {
          handled: true,
          text: error.message,
        };
      }

      debugWarn(
        "channels",
        "Failed to compact channel conversation for %s/%s: %s",
        runtime.agent_id,
        runtime.conversation_id,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      return {
        handled: true,
        text: buildChannelCompactFailedMessage(channelId),
      };
    }
  };
}
