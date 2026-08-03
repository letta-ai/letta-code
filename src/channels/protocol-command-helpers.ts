import type WebSocket from "ws";
import { getChannelPluginMetadata } from "@/channels/plugin-registry";
import type {
  ChannelAccountBindCommand,
  ChannelAccountCreateCommand,
  ChannelAccountDeleteCommand,
  ChannelAccountStartCommand,
  ChannelAccountStopCommand,
  ChannelAccountsListCommand,
  ChannelAccountUnbindCommand,
  ChannelAccountUpdateCommand,
  ChannelConfigSchema,
  ChannelGetConfigCommand,
  ChannelId,
  ChannelPairingBindCommand,
  ChannelPairingsListCommand,
  ChannelRouteRemoveCommand,
  ChannelRoutesListCommand,
  ChannelRouteUpdateCommand,
  ChannelSetConfigCommand,
  ChannelStartCommand,
  ChannelStopCommand,
  ChannelsListCommand,
  ChannelTargetBindCommand,
  ChannelTargetsListCommand,
  ChannelAccountSnapshot as ProtocolChannelAccountSnapshot,
  ChannelConfigSnapshot as ProtocolChannelConfigSnapshot,
} from "@/types/protocol_v2";

export type ChannelServiceSafeSocketSend = (
  socket: WebSocket,
  payload: unknown,
  errorType: string,
  context: string,
) => boolean;

export type ChannelServiceTaskRunner = (
  commandName: string,
  task: () => Promise<void>,
) => void;

// ---------------------------------------------------------------------------
// Service loader
// ---------------------------------------------------------------------------

export type ChannelsServiceModule = typeof import("@/channels/service");

let channelsServiceLoaderOverride:
  | null
  | (() => Promise<ChannelsServiceModule>) = null;

export function setChannelsServiceLoaderOverride(
  loader: null | (() => Promise<ChannelsServiceModule>),
): void {
  channelsServiceLoaderOverride = loader;
}

export async function loadChannelsService(): Promise<ChannelsServiceModule> {
  if (channelsServiceLoaderOverride) {
    return channelsServiceLoaderOverride();
  }
  return import("@/channels/service");
}

// ---------------------------------------------------------------------------
// Command union type
// ---------------------------------------------------------------------------

export type ChannelsCommand =
  | ChannelsListCommand
  | ChannelAccountsListCommand
  | ChannelAccountCreateCommand
  | ChannelAccountUpdateCommand
  | ChannelAccountBindCommand
  | ChannelAccountUnbindCommand
  | ChannelAccountDeleteCommand
  | ChannelAccountStartCommand
  | ChannelAccountStopCommand
  | ChannelGetConfigCommand
  | ChannelSetConfigCommand
  | ChannelStartCommand
  | ChannelStopCommand
  | ChannelPairingsListCommand
  | ChannelPairingBindCommand
  | ChannelRoutesListCommand
  | ChannelTargetsListCommand
  | ChannelTargetBindCommand
  | ChannelRouteUpdateCommand
  | ChannelRouteRemoveCommand;

// ---------------------------------------------------------------------------
// Emit helpers
// ---------------------------------------------------------------------------

export function emitChannelsUpdated(
  socket: WebSocket,
  safeSocketSend: ChannelServiceSafeSocketSend,
  channelId?: ChannelId,
): void {
  safeSocketSend(
    socket,
    {
      type: "channels_updated",
      timestamp: Date.now(),
      ...(channelId ? { channel_id: channelId } : {}),
    },
    "listener_channels_send_failed",
    "listener_channels_command",
  );
}

export function emitChannelAccountsUpdated(
  socket: WebSocket,
  safeSocketSend: ChannelServiceSafeSocketSend,
  params: { channelId: ChannelId; accountId?: string },
): void {
  safeSocketSend(
    socket,
    {
      type: "channel_accounts_updated",
      timestamp: Date.now(),
      channel_id: params.channelId,
      ...(params.accountId ? { account_id: params.accountId } : {}),
    },
    "listener_channels_send_failed",
    "listener_channels_command",
  );
}

export function emitChannelPairingsUpdated(
  socket: WebSocket,
  safeSocketSend: ChannelServiceSafeSocketSend,
  channelId: ChannelId,
): void {
  safeSocketSend(
    socket,
    {
      type: "channel_pairings_updated",
      timestamp: Date.now(),
      channel_id: channelId,
    },
    "listener_channels_send_failed",
    "listener_channels_command",
  );
}

export function emitChannelRoutesUpdated(
  socket: WebSocket,
  safeSocketSend: ChannelServiceSafeSocketSend,
  params: {
    channelId: ChannelId;
    agentId?: string;
    conversationId?: string | null;
  },
): void {
  safeSocketSend(
    socket,
    {
      type: "channel_routes_updated",
      timestamp: Date.now(),
      channel_id: params.channelId,
      ...(params.agentId ? { agent_id: params.agentId } : {}),
      ...(params.conversationId !== undefined
        ? { conversation_id: params.conversationId }
        : {}),
    },
    "listener_channels_send_failed",
    "listener_channels_command",
  );
}

export function emitChannelTargetsUpdated(
  socket: WebSocket,
  safeSocketSend: ChannelServiceSafeSocketSend,
  channelId: ChannelId,
): void {
  safeSocketSend(
    socket,
    {
      type: "channel_targets_updated",
      timestamp: Date.now(),
      channel_id: channelId,
    },
    "listener_channels_send_failed",
    "listener_channels_command",
  );
}

// ---------------------------------------------------------------------------
// Snapshot mappers
// ---------------------------------------------------------------------------

export function mapChannelSummary(
  summary: ReturnType<ChannelsServiceModule["listChannelSummaries"]>[number],
) {
  let configSchema: ChannelConfigSchema | null = null;
  try {
    configSchema =
      getChannelPluginMetadata(summary.channelId).configSchema ?? null;
  } catch {
    // Unsupported channel — leave schema null.
  }
  return {
    channel_id: summary.channelId,
    display_name: summary.displayName,
    configured: summary.configured,
    enabled: summary.enabled,
    running: summary.running,
    dm_policy: summary.dmPolicy,
    pending_pairings_count: summary.pendingPairingsCount,
    approved_users_count: summary.approvedUsersCount,
    routes_count: summary.routesCount,
    config_schema: configSchema,
  };
}

export function mapChannelConfig(
  snapshot: ReturnType<ChannelsServiceModule["getChannelConfigSnapshot"]>,
): ProtocolChannelConfigSnapshot | null {
  if (!snapshot) {
    return null;
  }
  return {
    channel_id: snapshot.channelId,
    account_id: snapshot.accountId,
    display_name: snapshot.displayName,
    enabled: snapshot.enabled,
    dm_policy: snapshot.dmPolicy,
    allowed_users: snapshot.allowedUsers,
    config: snapshot.config ?? {},
  };
}

export function mapChannelAccount(
  snapshot: ReturnType<
    ChannelsServiceModule["listChannelAccountSnapshots"]
  >[number],
): ProtocolChannelAccountSnapshot {
  return {
    channel_id: snapshot.channelId,
    account_id: snapshot.accountId,
    display_name: snapshot.displayName,
    enabled: snapshot.enabled,
    configured: snapshot.configured,
    running: snapshot.running,
    dm_policy: snapshot.dmPolicy,
    allowed_users: snapshot.allowedUsers,
    config: snapshot.config ?? {},
    created_at: snapshot.createdAt,
    updated_at: snapshot.updatedAt,
  };
}

export function mapRouteSnapshot(
  route: ReturnType<ChannelsServiceModule["listChannelRouteSnapshots"]>[number],
) {
  return {
    channel_id: route.channelId,
    account_id: route.accountId,
    chat_id: route.chatId,
    chat_type: route.chatType,
    thread_id: route.threadId ?? null,
    agent_id: route.agentId,
    conversation_id: route.conversationId,
    enabled: route.enabled,
    outbound_enabled: route.outboundEnabled,
    created_at: route.createdAt,
    updated_at: route.updatedAt,
  };
}

export function mapTargetSnapshot(
  target: ReturnType<
    ChannelsServiceModule["listChannelTargetSnapshots"]
  >[number],
) {
  return {
    channel_id: target.channelId,
    account_id: target.accountId,
    target_id: target.targetId,
    target_type: target.targetType,
    chat_id: target.chatId,
    label: target.label,
    discovered_at: target.discoveredAt,
    last_seen_at: target.lastSeenAt,
    ...(target.lastMessageId ? { last_message_id: target.lastMessageId } : {}),
  };
}
