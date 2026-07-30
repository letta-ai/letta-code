import type { ChannelRegistryEvent } from "@/channels/registry-events";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import type {
  ChannelAccountsUpdatedMessage,
  ChannelId,
  ChannelPairingsUpdatedMessage,
  ChannelsUpdatedMessage,
  ChannelTargetsUpdatedMessage,
} from "@/types/protocol_v2";
import {
  BROADCAST,
  resolveListenerConnectionTargets,
} from "@/websocket/listener/connection";
import { seedConversationWorkingDirectory } from "@/websocket/listener/cwd";
import {
  getOrCreateConversationPermissionModeStateRef,
  persistPermissionModeMapForRuntime,
} from "@/websocket/listener/permission-mode";
import { emitDeviceStatusUpdate } from "@/websocket/listener/protocol-outbound";
import { getOrCreateConversationRuntime } from "@/websocket/listener/runtime";
import {
  isListenerTransportOpen,
  type ListenerTransport,
} from "@/websocket/listener/transport";
import type { ListenerRuntime } from "@/websocket/listener/types";

type ChannelRegistryUpdateMessage =
  | ChannelsUpdatedMessage
  | ChannelAccountsUpdatedMessage
  | ChannelPairingsUpdatedMessage
  | ChannelTargetsUpdatedMessage;

function broadcastChannelRegistryUpdate(
  runtime: ListenerRuntime,
  origin: ListenerTransport,
  message: ChannelRegistryUpdateMessage,
): void {
  const payload = JSON.stringify(message);
  const targets = resolveListenerConnectionTargets({
    runtime,
    origin,
    scope: {},
    routing: BROADCAST,
    streamMessage: false,
  });
  for (const target of targets) {
    if (isListenerTransportOpen(target.transport)) {
      try {
        target.transport.send(payload);
      } catch (error) {
        trackBoundaryError({
          context: "listener_channel_registry_broadcast",
          errorType: "listener_channel_registry_send_failed",
          error,
        });
      }
    }
  }
}

export function handleChannelRegistryEvent(
  event: ChannelRegistryEvent,
  transport: ListenerTransport,
  runtime: ListenerRuntime,
): void {
  const broadcast = (message: ChannelRegistryUpdateMessage) =>
    broadcastChannelRegistryUpdate(runtime, transport, message);

  if (event.type === "pairings_updated") {
    const channelId = event.channelId as ChannelId;
    broadcast({
      type: "channel_pairings_updated",
      timestamp: Date.now(),
      channel_id: channelId,
    });
    broadcast({
      type: "channels_updated",
      timestamp: Date.now(),
      channel_id: channelId,
    });
    return;
  }

  if (event.type === "targets_updated") {
    const channelId = event.channelId as ChannelId;
    broadcast({
      type: "channel_targets_updated",
      timestamp: Date.now(),
      channel_id: channelId,
    });
    broadcast({
      type: "channels_updated",
      timestamp: Date.now(),
      channel_id: channelId,
    });
    return;
  }

  if (event.type === "channel_account_state_updated") {
    const channelId = event.channelId as ChannelId;
    broadcast({
      type: "channel_accounts_updated",
      timestamp: Date.now(),
      channel_id: channelId,
      account_id: event.accountId,
    });
    broadcast({
      type: "channels_updated",
      timestamp: Date.now(),
      channel_id: channelId,
    });
    return;
  }

  const permissionModeState = getOrCreateConversationPermissionModeStateRef(
    runtime,
    event.agentId,
    event.conversationId,
  );
  permissionModeState.mode = event.defaultPermissionMode;
  persistPermissionModeMapForRuntime(runtime);

  const seededWorkingDirectory = seedConversationWorkingDirectory(
    runtime,
    event.agentId,
    event.conversationId,
    runtime.bootWorkingDirectory,
  );
  if (seededWorkingDirectory) {
    emitDeviceStatusUpdate(
      transport,
      getOrCreateConversationRuntime(
        runtime,
        event.agentId,
        event.conversationId,
      ),
    );
  }
}
