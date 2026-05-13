import WebSocket from "ws";
import {
  channelPluginConfigShouldRefreshDisplayName,
  getChannelPluginConfig,
} from "../../../channels/accountConfig";
import type { ChannelRegistryEvent } from "../../../channels/registry";
import type { DequeuedBatch } from "../../../queue/queueRuntime";
import type {
  ChannelAccountBindCommand,
  ChannelAccountCreateCommand,
  ChannelAccountDeleteCommand,
  ChannelAccountStartCommand,
  ChannelAccountStopCommand,
  ChannelAccountsListCommand,
  ChannelAccountUnbindCommand,
  ChannelAccountUpdateCommand,
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
} from "../../../types/protocol_v2";
import {
  getOrCreateConversationPermissionModeStateRef,
  persistPermissionModeMapForRuntime,
} from "../permissionMode";
import {
  isChannelAccountBindCommand,
  isChannelAccountCreateCommand,
  isChannelAccountDeleteCommand,
  isChannelAccountStartCommand,
  isChannelAccountStopCommand,
  isChannelAccountsListCommand,
  isChannelAccountUnbindCommand,
  isChannelAccountUpdateCommand,
  isChannelGetConfigCommand,
  isChannelPairingBindCommand,
  isChannelPairingsListCommand,
  isChannelRouteRemoveCommand,
  isChannelRoutesListCommand,
  isChannelRouteUpdateCommand,
  isChannelSetConfigCommand,
  isChannelStartCommand,
  isChannelStopCommand,
  isChannelsListCommand,
  isChannelTargetBindCommand,
  isChannelTargetsListCommand,
} from "../protocol-inbound";
import type { ListenerTransport } from "../transport";
import type {
  IncomingMessage,
  ListenerRuntime,
  StartListenerOptions,
} from "../types";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

type ChannelsServiceModule = typeof import("../../../channels/service");

type ProcessQueuedTurn = (
  queuedTurn: IncomingMessage,
  dequeuedBatch: DequeuedBatch,
) => Promise<void>;

type WireChannelIngress = (
  listener: ListenerRuntime,
  socket: ListenerTransport,
  opts: StartListenerOptions,
  processQueuedTurn: ProcessQueuedTurn,
) => Promise<void>;

let channelsServiceLoaderOverride:
  | null
  | (() => Promise<ChannelsServiceModule>) = null;

export function setChannelsServiceLoaderOverride(
  loader: null | (() => Promise<ChannelsServiceModule>),
): void {
  channelsServiceLoaderOverride = loader;
}

async function loadChannelsService(): Promise<ChannelsServiceModule> {
  if (channelsServiceLoaderOverride) {
    return channelsServiceLoaderOverride();
  }
  return import("../../../channels/service");
}

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

export function isDetachedChannelsCommand(
  parsed: unknown,
): parsed is ChannelsCommand {
  return (
    isChannelsListCommand(parsed) ||
    isChannelAccountsListCommand(parsed) ||
    isChannelAccountCreateCommand(parsed) ||
    isChannelAccountUpdateCommand(parsed) ||
    isChannelAccountBindCommand(parsed) ||
    isChannelAccountUnbindCommand(parsed) ||
    isChannelAccountDeleteCommand(parsed) ||
    isChannelAccountStartCommand(parsed) ||
    isChannelAccountStopCommand(parsed) ||
    isChannelGetConfigCommand(parsed) ||
    isChannelSetConfigCommand(parsed) ||
    isChannelStartCommand(parsed) ||
    isChannelStopCommand(parsed) ||
    isChannelPairingsListCommand(parsed) ||
    isChannelPairingBindCommand(parsed) ||
    isChannelRoutesListCommand(parsed) ||
    isChannelTargetsListCommand(parsed) ||
    isChannelTargetBindCommand(parsed) ||
    isChannelRouteUpdateCommand(parsed) ||
    isChannelRouteRemoveCommand(parsed)
  );
}

function emitChannelsUpdated(
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
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

function emitChannelAccountsUpdated(
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
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

function emitChannelPairingsUpdated(
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
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

function emitChannelRoutesUpdated(
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
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

function emitChannelTargetsUpdated(
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
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

export async function handleChannelsProtocolCommand(
  parsed: ChannelsCommand,
  socket: WebSocket,
  runtime: ListenerRuntime,
  opts: Pick<StartListenerOptions, "onStatusChange" | "connectionId">,
  processQueuedTurn: ProcessQueuedTurn,
  runDetachedListenerTask: RunDetachedListenerTask,
  wireChannelIngress: WireChannelIngress,
  safeSocketSend: SafeSocketSend,
): Promise<boolean> {
  const {
    bindChannelPairing,
    bindChannelAccountLive,
    bindChannelTarget,
    createChannelAccountLive,
    refreshChannelAccountDisplayNameLive,
    getChannelConfigSnapshot,
    listChannelAccountSnapshots,
    listChannelRouteSnapshots,
    listChannelSummaries,
    listPendingPairingSnapshots,
    listChannelTargetSnapshots,
    removeChannelAccountLive,
    removeChannelRouteLive,
    setChannelConfigLive,
    startChannelAccountLive,
    startChannelLive,
    stopChannelAccountLive,
    stopChannelLive,
    unbindChannelAccountLive,
    updateChannelAccountLive,
    updateChannelRouteLive,
  } = await loadChannelsService();

  const mapChannelSummary = (
    summary: ReturnType<typeof listChannelSummaries>[number],
  ) => ({
    channel_id: summary.channelId,
    display_name: summary.displayName,
    configured: summary.configured,
    enabled: summary.enabled,
    running: summary.running,
    dm_policy: summary.dmPolicy,
    pending_pairings_count: summary.pendingPairingsCount,
    approved_users_count: summary.approvedUsersCount,
    routes_count: summary.routesCount,
  });

  const mapChannelConfig = (
    snapshot: ReturnType<typeof getChannelConfigSnapshot>,
  ): ProtocolChannelConfigSnapshot | null => {
    if (!snapshot) {
      return null;
    }
    if (snapshot.channelId === "telegram") {
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
    if (snapshot.channelId === "discord") {
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
    return {
      channel_id: snapshot.channelId,
      account_id: snapshot.accountId,
      display_name: snapshot.displayName,
      enabled: snapshot.enabled,
      dm_policy: snapshot.dmPolicy,
      allowed_users: snapshot.allowedUsers,
      config: snapshot.config ?? {},
    };
  };

  const mapChannelAccount = (
    snapshot: ReturnType<typeof listChannelAccountSnapshots>[number],
  ): ProtocolChannelAccountSnapshot => {
    if (snapshot.channelId === "telegram") {
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

    if (snapshot.channelId === "discord") {
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
  };

  const mapRouteSnapshot = (
    route: ReturnType<typeof listChannelRouteSnapshots>[number],
  ) => ({
    channel_id: route.channelId,
    account_id: route.accountId,
    chat_id: route.chatId,
    chat_type: route.chatType,
    thread_id: route.threadId ?? null,
    agent_id: route.agentId,
    conversation_id: route.conversationId,
    enabled: route.enabled,
    created_at: route.createdAt,
    updated_at: route.updatedAt,
  });

  const mapTargetSnapshot = (
    target: ReturnType<typeof listChannelTargetSnapshots>[number],
  ) => ({
    channel_id: target.channelId,
    account_id: target.accountId,
    target_id: target.targetId,
    target_type: target.targetType,
    chat_id: target.chatId,
    label: target.label,
    discovered_at: target.discoveredAt,
    last_seen_at: target.lastSeenAt,
    ...(target.lastMessageId ? { last_message_id: target.lastMessageId } : {}),
  });

  if (parsed.type === "channels_list") {
    try {
      safeSocketSend(
        socket,
        {
          type: "channels_list_response",
          request_id: parsed.request_id,
          success: true,
          channels: listChannelSummaries().map(mapChannelSummary),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channels_list_response",
          request_id: parsed.request_id,
          success: false,
          channels: [],
          error: err instanceof Error ? err.message : "Failed to list channels",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_accounts_list") {
    try {
      const accounts = listChannelAccountSnapshots(parsed.channel_id);
      safeSocketSend(
        socket,
        {
          type: "channel_accounts_list_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          accounts: accounts.map(mapChannelAccount),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );

      const accountsNeedingRefresh = accounts.filter((account) =>
        parsed.channel_id === "slack" ? true : !account.displayName,
      );

      if (accountsNeedingRefresh.length > 0) {
        runDetachedListenerTask("channel_accounts_refresh", async () => {
          const refreshResults = await Promise.allSettled(
            accountsNeedingRefresh.map(async (account) => {
              const refreshed =
                parsed.channel_id === "slack"
                  ? await refreshChannelAccountDisplayNameLive(
                      parsed.channel_id,
                      account.accountId,
                      { force: true },
                    )
                  : await refreshChannelAccountDisplayNameLive(
                      parsed.channel_id,
                      account.accountId,
                    );

              return refreshed.displayName !== account.displayName;
            }),
          );

          if (
            refreshResults.some(
              (result) => result.status === "fulfilled" && result.value,
            )
          ) {
            emitChannelAccountsUpdated(socket, safeSocketSend, {
              channelId: parsed.channel_id,
            });
            emitChannelsUpdated(socket, safeSocketSend, parsed.channel_id);
          }
        });
      }
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_accounts_list_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          accounts: [],
          error:
            err instanceof Error
              ? err.message
              : "Failed to list channel accounts",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_account_create") {
    try {
      const pluginConfig =
        getChannelPluginConfig(parsed.account as Record<string, unknown>) ?? {};
      const created = createChannelAccountLive(
        parsed.channel_id,
        {
          displayName:
            "display_name" in parsed.account
              ? parsed.account.display_name
              : undefined,
          enabled:
            "enabled" in parsed.account ? parsed.account.enabled : undefined,
          dmPolicy: parsed.account.dm_policy,
          allowedUsers: parsed.account.allowed_users,
          config: pluginConfig,
        },
        {
          accountId:
            "account_id" in parsed.account
              ? parsed.account.account_id
              : undefined,
        },
      );
      const account =
        "display_name" in parsed.account
          ? created
          : await refreshChannelAccountDisplayNameLive(
              parsed.channel_id,
              created.accountId,
              { force: true },
            );

      safeSocketSend(
        socket,
        {
          type: "channel_account_create_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          account: mapChannelAccount(account),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelAccountsUpdated(socket, safeSocketSend, {
        channelId: parsed.channel_id,
        accountId: account.accountId,
      });
      emitChannelsUpdated(socket, safeSocketSend, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_account_create_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          account: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to create channel account",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_account_update") {
    try {
      const pluginConfig =
        getChannelPluginConfig(parsed.patch as Record<string, unknown>) ?? {};
      const updated = updateChannelAccountLive(
        parsed.channel_id,
        parsed.account_id,
        {
          displayName:
            "display_name" in parsed.patch
              ? parsed.patch.display_name
              : undefined,
          enabled: "enabled" in parsed.patch ? parsed.patch.enabled : undefined,
          dmPolicy: parsed.patch.dm_policy,
          allowedUsers: parsed.patch.allowed_users,
          config: pluginConfig,
        },
      );
      const shouldRefreshDisplayName =
        !("display_name" in parsed.patch) &&
        channelPluginConfigShouldRefreshDisplayName(parsed.channel_id, {
          config: pluginConfig,
        });
      const account = shouldRefreshDisplayName
        ? await refreshChannelAccountDisplayNameLive(
            parsed.channel_id,
            parsed.account_id,
            { force: true },
          )
        : updated;

      safeSocketSend(
        socket,
        {
          type: "channel_account_update_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          account: mapChannelAccount(account),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelAccountsUpdated(socket, safeSocketSend, {
        channelId: parsed.channel_id,
        accountId: parsed.account_id,
      });
      emitChannelsUpdated(socket, safeSocketSend, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_account_update_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          account: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to update channel account",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_account_bind") {
    try {
      const account = bindChannelAccountLive(
        parsed.channel_id,
        parsed.account_id,
        parsed.runtime.agent_id,
        parsed.runtime.conversation_id,
      );

      safeSocketSend(
        socket,
        {
          type: "channel_account_bind_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          account: mapChannelAccount(account),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelAccountsUpdated(socket, safeSocketSend, {
        channelId: parsed.channel_id,
        accountId: parsed.account_id,
      });
      emitChannelsUpdated(socket, safeSocketSend, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_account_bind_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          account: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to bind channel account",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_account_unbind") {
    try {
      const account = unbindChannelAccountLive(
        parsed.channel_id,
        parsed.account_id,
      );

      safeSocketSend(
        socket,
        {
          type: "channel_account_unbind_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          account: mapChannelAccount(account),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelAccountsUpdated(socket, safeSocketSend, {
        channelId: parsed.channel_id,
        accountId: parsed.account_id,
      });
      emitChannelsUpdated(socket, safeSocketSend, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_account_unbind_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          account: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to unbind channel account",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_account_delete") {
    try {
      const deleted = await removeChannelAccountLive(
        parsed.channel_id,
        parsed.account_id,
      );

      safeSocketSend(
        socket,
        {
          type: "channel_account_delete_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          account_id: parsed.account_id,
          deleted,
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      if (deleted) {
        emitChannelAccountsUpdated(socket, safeSocketSend, {
          channelId: parsed.channel_id,
          accountId: parsed.account_id,
        });
        emitChannelPairingsUpdated(socket, safeSocketSend, parsed.channel_id);
        emitChannelRoutesUpdated(socket, safeSocketSend, {
          channelId: parsed.channel_id,
        });
        emitChannelTargetsUpdated(socket, safeSocketSend, parsed.channel_id);
        emitChannelsUpdated(socket, safeSocketSend, parsed.channel_id);
      }
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_account_delete_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          account_id: parsed.account_id,
          deleted: false,
          error:
            err instanceof Error
              ? err.message
              : "Failed to delete channel account",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_account_start") {
    try {
      const account = await startChannelAccountLive(
        parsed.channel_id,
        parsed.account_id,
      );
      await wireChannelIngress(
        runtime,
        socket,
        opts as StartListenerOptions,
        processQueuedTurn,
      );
      safeSocketSend(
        socket,
        {
          type: "channel_account_start_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          account: mapChannelAccount(account),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelAccountsUpdated(socket, safeSocketSend, {
        channelId: parsed.channel_id,
        accountId: parsed.account_id,
      });
      emitChannelsUpdated(socket, safeSocketSend, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_account_start_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          account: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to start channel account",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_account_stop") {
    try {
      const account = await stopChannelAccountLive(
        parsed.channel_id,
        parsed.account_id,
      );
      safeSocketSend(
        socket,
        {
          type: "channel_account_stop_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          account: mapChannelAccount(account),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelAccountsUpdated(socket, safeSocketSend, {
        channelId: parsed.channel_id,
        accountId: parsed.account_id,
      });
      emitChannelsUpdated(socket, safeSocketSend, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_account_stop_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          account: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to stop channel account",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_get_config") {
    try {
      safeSocketSend(
        socket,
        {
          type: "channel_get_config_response",
          request_id: parsed.request_id,
          success: true,
          config: mapChannelConfig(
            getChannelConfigSnapshot(parsed.channel_id, parsed.account_id),
          ),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_get_config_response",
          request_id: parsed.request_id,
          success: false,
          config: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to read channel config",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_set_config") {
    try {
      const pluginConfig =
        getChannelPluginConfig(
          parsed.config as Record<string, unknown>,
          "plugin_config",
        ) ?? {};
      const snapshot = await setChannelConfigLive(
        parsed.channel_id,
        {
          dmPolicy: parsed.config.dm_policy,
          allowedUsers: parsed.config.allowed_users,
          config: pluginConfig,
        },
        parsed.account_id,
      );

      if (snapshot.enabled) {
        await wireChannelIngress(
          runtime,
          socket,
          opts as StartListenerOptions,
          processQueuedTurn,
        );
      }

      safeSocketSend(
        socket,
        {
          type: "channel_set_config_response",
          request_id: parsed.request_id,
          success: true,
          config: mapChannelConfig(snapshot),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelAccountsUpdated(socket, safeSocketSend, {
        channelId: parsed.channel_id,
        accountId: snapshot.accountId,
      });
      emitChannelsUpdated(socket, safeSocketSend, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_set_config_response",
          request_id: parsed.request_id,
          success: false,
          config: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to update channel config",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_start") {
    try {
      const summary = await startChannelLive(
        parsed.channel_id,
        parsed.account_id,
      );
      await wireChannelIngress(
        runtime,
        socket,
        opts as StartListenerOptions,
        processQueuedTurn,
      );
      safeSocketSend(
        socket,
        {
          type: "channel_start_response",
          request_id: parsed.request_id,
          success: true,
          channel: mapChannelSummary(summary),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelsUpdated(socket, safeSocketSend, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_start_response",
          request_id: parsed.request_id,
          success: false,
          channel: null,
          error: err instanceof Error ? err.message : "Failed to start channel",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_stop") {
    try {
      const summary = await stopChannelLive(
        parsed.channel_id,
        parsed.account_id,
      );
      safeSocketSend(
        socket,
        {
          type: "channel_stop_response",
          request_id: parsed.request_id,
          success: true,
          channel: mapChannelSummary(summary),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelsUpdated(socket, safeSocketSend, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_stop_response",
          request_id: parsed.request_id,
          success: false,
          channel: null,
          error: err instanceof Error ? err.message : "Failed to stop channel",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

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

  if (parsed.type === "channel_routes_list") {
    try {
      const channelId = parsed.channel_id ?? "telegram";
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
      emitChannelAccountsUpdated(socket, safeSocketSend, {
        channelId: parsed.channel_id,
        accountId: route.accountId,
      });
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

export function handleChannelRegistryEvent(
  event: ChannelRegistryEvent,
  socket: ListenerTransport,
  runtime: ListenerRuntime,
  safeSocketSend: SafeSocketSend,
): void {
  if (event.type === "pairings_updated") {
    if (socket instanceof WebSocket) {
      emitChannelPairingsUpdated(
        socket,
        safeSocketSend,
        event.channelId as ChannelId,
      );
      emitChannelsUpdated(socket, safeSocketSend, event.channelId as ChannelId);
    }
    return;
  }

  if (event.type === "targets_updated") {
    if (socket instanceof WebSocket) {
      emitChannelTargetsUpdated(
        socket,
        safeSocketSend,
        event.channelId as ChannelId,
      );
      emitChannelsUpdated(socket, safeSocketSend, event.channelId as ChannelId);
    }
    return;
  }

  const permissionModeState = getOrCreateConversationPermissionModeStateRef(
    runtime,
    event.agentId,
    event.conversationId,
  );
  permissionModeState.mode = event.defaultPermissionMode;
  permissionModeState.planFilePath = null;
  permissionModeState.modeBeforePlan = null;
  persistPermissionModeMapForRuntime(runtime);
}
