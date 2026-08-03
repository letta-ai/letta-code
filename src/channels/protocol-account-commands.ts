import type WebSocket from "ws";
import {
  getChannelPluginConfig,
  isValidChannelPluginConfigPayload,
} from "@/channels/account-config";
import { removeUserPlugin } from "@/channels/custom/scaffolding";
import type { ChannelsCommand } from "@/channels/protocol-command-helpers";
import {
  type ChannelServiceSafeSocketSend,
  type ChannelServiceTaskRunner,
  type ChannelsServiceModule,
  emitChannelAccountsUpdated,
  emitChannelPairingsUpdated,
  emitChannelRoutesUpdated,
  emitChannelsUpdated,
  emitChannelTargetsUpdated,
  mapChannelAccount,
  mapChannelConfig,
  mapChannelSummary,
} from "@/channels/protocol-command-helpers";

/**
 * Handles account, config, and lifecycle channel protocol commands.
 * Returns `true` when the command was handled, `false` when the command type
 * does not belong to this group (so the caller can try the next handler).
 */
export async function handleAccountConfigLifecycleCommand(
  parsed: ChannelsCommand,
  socket: WebSocket,
  runDetachedListenerTask: ChannelServiceTaskRunner,
  safeSocketSend: ChannelServiceSafeSocketSend,
  service: ChannelsServiceModule,
): Promise<boolean> {
  const {
    refreshChannelAccountDisplayNameLive,
    getChannelConfigSnapshot,
    listChannelAccountSnapshots,
    listChannelSummaries,
    removeChannelAccountLive,
    setChannelConfigLive,
    startChannelAccountLive,
    startChannelLive,
    stopChannelAccountLive,
    stopChannelLive,
    createChannelAccountLive,
    updateChannelAccountLive,
    bindChannelAccountLive,
    unbindChannelAccountLive,
  } = service;

  // -- channels_list --------------------------------------------------------

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

  // -- channel_accounts_list -------------------------------------------------

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

      const accountsNeedingRefresh = accounts.filter(
        (account) => !account.displayName,
      );

      if (accountsNeedingRefresh.length > 0) {
        runDetachedListenerTask("channel_accounts_refresh", async () => {
          const refreshResults = await Promise.allSettled(
            accountsNeedingRefresh.map(async (account) => {
              const refreshed = await refreshChannelAccountDisplayNameLive(
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

  // -- channel_account_create ------------------------------------------------

  if (parsed.type === "channel_account_create") {
    try {
      if (
        !isValidChannelPluginConfigPayload(
          parsed.channel_id,
          parsed.account as Record<string, unknown>,
        )
      ) {
        throw new Error("Invalid channel account config");
      }
      // Custom-app model: multiple custom apps are represented as
      // multiple accounts under the first-party "custom" channel. Do not
      // scaffold per-app plugin folders/channel IDs here.
      const effectiveChannelId = parsed.channel_id;

      const pluginConfig =
        getChannelPluginConfig(parsed.account as Record<string, unknown>) ?? {};
      const created = createChannelAccountLive(
        effectiveChannelId,
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
      const account = created;

      safeSocketSend(
        socket,
        {
          type: "channel_account_create_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: effectiveChannelId,
          account: mapChannelAccount(account),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelAccountsUpdated(socket, safeSocketSend, {
        channelId: effectiveChannelId,
        accountId: account.accountId,
      });
      emitChannelsUpdated(socket, safeSocketSend, effectiveChannelId);
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

  // -- channel_account_update ------------------------------------------------

  if (parsed.type === "channel_account_update") {
    try {
      if (
        !isValidChannelPluginConfigPayload(
          parsed.channel_id,
          parsed.patch as Record<string, unknown>,
        )
      ) {
        throw new Error("Invalid channel account config");
      }
      const pluginConfig =
        getChannelPluginConfig(parsed.patch as Record<string, unknown>) ?? {};
      const accountPatch = {
        displayName:
          "display_name" in parsed.patch
            ? parsed.patch.display_name
            : undefined,
        enabled: "enabled" in parsed.patch ? parsed.patch.enabled : undefined,
        dmPolicy: parsed.patch.dm_policy,
        allowedUsers: parsed.patch.allowed_users,
        config: pluginConfig,
      };
      const account = updateChannelAccountLive(
        parsed.channel_id,
        parsed.account_id,
        accountPatch,
      );

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

  // -- channel_account_bind --------------------------------------------------

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

  // -- channel_account_unbind ------------------------------------------------

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

  // -- channel_account_delete ------------------------------------------------

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
        // Remove the plugin folder if this was a user-scaffolded channel
        // so the display name can be reused.
        removeUserPlugin(parsed.channel_id);

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

  // -- channel_account_start -------------------------------------------------

  if (parsed.type === "channel_account_start") {
    try {
      const account = await startChannelAccountLive(
        parsed.channel_id,
        parsed.account_id,
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

  // -- channel_account_stop --------------------------------------------------

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

  // -- channel_get_config ----------------------------------------------------

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

  // -- channel_set_config ----------------------------------------------------

  if (parsed.type === "channel_set_config") {
    try {
      if (
        !isValidChannelPluginConfigPayload(
          parsed.channel_id,
          parsed.config as Record<string, unknown>,
          "plugin_config",
        )
      ) {
        throw new Error("Invalid channel config");
      }
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

  // -- channel_start ---------------------------------------------------------

  if (parsed.type === "channel_start") {
    try {
      const summary = await startChannelLive(
        parsed.channel_id,
        parsed.account_id,
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

  // -- channel_stop ----------------------------------------------------------

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

  return false;
}
