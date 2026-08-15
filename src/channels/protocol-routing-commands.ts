import type WebSocket from "ws";
import type { ChannelsCommand } from "@/channels/protocol-command-helpers";
import {
  type ChannelServiceSafeSocketSend,
  type ChannelsServiceModule,
  emitChannelPairingsUpdated,
  emitChannelRoutesUpdated,
  emitChannelsUpdated,
  emitChannelTargetsUpdated,
  mapRouteSnapshot,
  mapTargetSnapshot,
} from "@/channels/protocol-command-helpers";
import { LEGACY_DEFAULT_CHANNEL_ID } from "@/channels/types";

/**
 * Handles routing, pairing, and target channel protocol commands.
 * Returns `true` when the command was handled, `false` when the command type
 * does not belong to this group (so the caller can try the next handler).
 *
 * If none of the explicit type guards match the command is assumed to be
 * `channel_route_remove` — mirroring the original fall-through behaviour
 * since `isDetachedChannelsCommand` has already validated the union.
 */
export function handleRoutingPairingTargetCommand(
  parsed: ChannelsCommand,
  socket: WebSocket,
  safeSocketSend: ChannelServiceSafeSocketSend,
  service: ChannelsServiceModule,
): boolean {
  const {
    bindChannelPairing,
    bindChannelTarget,
    listChannelRouteSnapshots,
    listPendingPairingSnapshots,
    listChannelTargetSnapshots,
    removeChannelRouteLive,
    updateChannelRouteLive,
  } = service;

  // -- channel_pairings_list -------------------------------------------------

  if (parsed.type === "channel_pairings_list") {
    try {
      safeSocketSend(
        socket,
        {
          type: "channel_pairings_list_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          pending: listPendingPairingSnapshots(
            parsed.channel_id,
            parsed.account_id,
          ).map((pending) => ({
            account_id: pending.accountId,
            code: pending.code,
            sender_id: pending.senderId,
            sender_name: pending.senderName,
            chat_id: pending.chatId,
            created_at: pending.createdAt,
            expires_at: pending.expiresAt,
          })),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_pairings_list_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          pending: [],
          error:
            err instanceof Error
              ? err.message
              : "Failed to list pending pairings",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  // -- channel_pairing_bind --------------------------------------------------

  if (parsed.type === "channel_pairing_bind") {
    try {
      const result = bindChannelPairing(
        parsed.channel_id,
        parsed.code,
        parsed.runtime.agent_id,
        parsed.runtime.conversation_id,
        parsed.account_id,
      );
      safeSocketSend(
        socket,
        {
          type: "channel_pairing_bind_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          chat_id: result.chatId,
          route: mapRouteSnapshot(result.route),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelPairingsUpdated(socket, safeSocketSend, parsed.channel_id);
      emitChannelRoutesUpdated(socket, safeSocketSend, {
        channelId: parsed.channel_id,
        agentId: parsed.runtime.agent_id,
        conversationId: parsed.runtime.conversation_id,
      });
      emitChannelsUpdated(socket, safeSocketSend, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_pairing_bind_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          route: null,
          error: err instanceof Error ? err.message : "Failed to bind pairing",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  // -- channel_routes_list ---------------------------------------------------

  if (parsed.type === "channel_routes_list") {
    try {
      const channelId = parsed.channel_id ?? LEGACY_DEFAULT_CHANNEL_ID;
      safeSocketSend(
        socket,
        {
          type: "channel_routes_list_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: channelId,
          routes: listChannelRouteSnapshots({
            channelId,
            accountId: parsed.account_id,
            agentId: parsed.agent_id,
            conversationId: parsed.conversation_id,
          }).map(mapRouteSnapshot),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_routes_list_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          routes: [],
          error: err instanceof Error ? err.message : "Failed to list routes",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  // -- channel_targets_list --------------------------------------------------

  if (parsed.type === "channel_targets_list") {
    try {
      safeSocketSend(
        socket,
        {
          type: "channel_targets_list_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          targets: listChannelTargetSnapshots(
            parsed.channel_id,
            parsed.account_id,
          ).map(mapTargetSnapshot),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_targets_list_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          targets: [],
          error:
            err instanceof Error
              ? err.message
              : "Failed to list channel targets",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  // -- channel_target_bind ---------------------------------------------------

  if (parsed.type === "channel_target_bind") {
    try {
      const result = bindChannelTarget(
        parsed.channel_id,
        parsed.target_id,
        parsed.runtime.agent_id,
        parsed.runtime.conversation_id,
        parsed.account_id,
      );
      safeSocketSend(
        socket,
        {
          type: "channel_target_bind_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          target_id: parsed.target_id,
          chat_id: result.chatId,
          route: mapRouteSnapshot(result.route),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelTargetsUpdated(socket, safeSocketSend, parsed.channel_id);
      emitChannelRoutesUpdated(socket, safeSocketSend, {
        channelId: parsed.channel_id,
        agentId: parsed.runtime.agent_id,
        conversationId: parsed.runtime.conversation_id,
      });
      emitChannelsUpdated(socket, safeSocketSend, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_target_bind_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          target_id: parsed.target_id,
          route: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to bind channel target",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  // -- channel_route_update --------------------------------------------------

  if (parsed.type === "channel_route_update") {
    try {
      const route = updateChannelRouteLive(
        parsed.channel_id,
        parsed.chat_id,
        parsed.runtime.agent_id,
        parsed.runtime.conversation_id,
        parsed.account_id,
      );
      safeSocketSend(
        socket,
        {
          type: "channel_route_update_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          chat_id: parsed.chat_id,
          route: mapRouteSnapshot(route),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelRoutesUpdated(socket, safeSocketSend, {
        channelId: parsed.channel_id,
        agentId: parsed.runtime.agent_id,
        conversationId: parsed.runtime.conversation_id,
      });
      emitChannelsUpdated(socket, safeSocketSend, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_route_update_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          chat_id: parsed.chat_id,
          route: null,
          error: err instanceof Error ? err.message : "Failed to update route",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  // -- channel_route_remove (fall-through) -----------------------------------
  // If none of the explicit routing type guards above matched, the command
  // must be `channel_route_remove` — `isDetachedChannelsCommand` has already
  // validated the union and the account/config/lifecycle handler has already
  // returned `false` for non-routing commands.

  if (parsed.type === "channel_route_remove") {
    try {
      const found = removeChannelRouteLive(
        parsed.channel_id,
        parsed.chat_id,
        parsed.account_id,
      );
      safeSocketSend(
        socket,
        {
          type: "channel_route_remove_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          chat_id: parsed.chat_id,
          found,
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      if (found) {
        emitChannelRoutesUpdated(socket, safeSocketSend, {
          channelId: parsed.channel_id,
        });
        emitChannelsUpdated(socket, safeSocketSend, parsed.channel_id);
      }
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_route_remove_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          chat_id: parsed.chat_id,
          found: false,
          error: err instanceof Error ? err.message : "Failed to remove route",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  return false;
}
