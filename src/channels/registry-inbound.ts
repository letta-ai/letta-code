import { getChannelAccount, LEGACY_CHANNEL_ACCOUNT_ID } from "./accounts";
import {
  parseLettaEscapeHatch,
  tryHandleChannelSlashCommand,
} from "./commands";
import { isDiscordGuildChannelAllowed } from "./discord/channel-gating";
import { createPairingCode, isUserApproved, loadPairingStore } from "./pairing";
import type { ChannelCommandRouter } from "./registry-commands";
import type { ChannelControlRequests } from "./registry-controls";
import type { ChannelRegistryEvent } from "./registry-events";
import type { ChannelInboundDelivery } from "./registry-handlers";
import {
  buildChannelTurnSource,
  buildPairingInstructions,
  buildUnboundRouteInstructions,
  getConfiguredAgentId,
} from "./registry-presentation";
import type { ChannelRouteProvisioner } from "./registry-routes";
import { getRoute as getRouteFromStore, loadRoutes } from "./routing";
import type {
  ChannelAccount,
  ChannelAdapter,
  ChannelRoute,
  ChannelTurnLifecycleEvent,
  InboundChannelMessage,
} from "./types";
import {
  isDiscordChannelAccount,
  isSignalChannelAccount,
  isSlackChannelAccount,
  isTelegramChannelAccount,
  isWhatsAppChannelAccount,
} from "./types";
import { formatChannelNotification } from "./xml";

export function createChannelInboundRouter(deps: {
  controls: ChannelControlRequests;
  commands: ChannelCommandRouter;
  routes: ChannelRouteProvisioner;
  getAdapter: (channelId: string, accountId: string) => ChannelAdapter | null;
  dispatchTurnLifecycleEvent: (
    event: ChannelTurnLifecycleEvent,
  ) => Promise<void>;
  deliver: (delivery: ChannelInboundDelivery) => void;
  emitEvent: (event: ChannelRegistryEvent) => void;
}) {
  async function rejectByDmPolicy(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    config: ChannelAccount,
    accountId: string,
  ): Promise<boolean> {
    if (config.dmPolicy === "allowlist") {
      if (!config.allowedUsers.includes(msg.senderId)) {
        if (!msg.reaction) {
          await adapter.sendDirectReply(
            msg.chatId,
            "You are not on the allowed users list for this bot.",
          );
        }
        return true;
      }
      return false;
    }

    if (config.dmPolicy !== "pairing") {
      return false;
    }

    // Reload pairing store from disk on miss (allows standalone CLI pairing).
    if (!isUserApproved(msg.channel, msg.senderId, accountId)) {
      loadPairingStore(msg.channel);
    }
    if (isUserApproved(msg.channel, msg.senderId, accountId)) {
      return false;
    }

    if (!msg.reaction) {
      const code = createPairingCode(
        msg.channel,
        msg.senderId,
        msg.chatId,
        msg.senderName,
        accountId,
      );
      deps.emitEvent({
        type: "pairings_updated",
        channelId: msg.channel,
      });
      await adapter.sendDirectReply(
        msg.chatId,
        buildPairingInstructions(msg.channel, code, {
          agentId: getConfiguredAgentId(config),
        }),
      );
    }
    return true;
  }

  async function handleInboundMessage(
    msg: InboundChannelMessage,
  ): Promise<void> {
    const accountId = msg.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    const adapter = deps.getAdapter(msg.channel, accountId);
    if (!adapter) return;
    if (await deps.controls.tryHandleInbound(adapter, msg)) {
      return;
    }

    const config = getChannelAccount(msg.channel, accountId);

    if (
      deps.commands.shouldDropUnroutedSlackThreadInput(msg, accountId, config)
    ) {
      return;
    }

    const lettaEscapeHatchText = parseLettaEscapeHatch(msg.text);
    if (lettaEscapeHatchText !== null) {
      if (!config || config.enabled === false) {
        return;
      }

      if (
        msg.chatType === "direct" &&
        (await rejectByDmPolicy(adapter, msg, config, accountId))
      ) {
        return;
      }

      if (
        await deps.commands.handleLettaEscapeHatch(
          adapter,
          msg,
          lettaEscapeHatchText,
        )
      ) {
        return;
      }
    }

    const getStatusRoute = (): ChannelRoute | null => {
      let statusRoute = getRouteFromStore(
        msg.channel,
        msg.chatId,
        accountId,
        msg.threadId,
      );
      if (!statusRoute) {
        loadRoutes(msg.channel);
        statusRoute = getRouteFromStore(
          msg.channel,
          msg.chatId,
          accountId,
          msg.threadId,
        );
      }
      return statusRoute;
    };

    if (
      await tryHandleChannelSlashCommand(adapter, msg, {
        statusContext: {
          adapterRunning: adapter.isRunning(),
          accountConfigured: !!config,
          accountEnabled: config?.enabled,
          route: getStatusRoute(),
        },
        handlers: {
          cancel: async (_command, commandMsg) =>
            deps.commands.handleCancelSlashCommand(commandMsg),
          chat: async (_command, commandMsg) =>
            deps.commands.handleChatSlashCommand(commandMsg),
          detach: async (_command, commandMsg) =>
            deps.commands.handleDetachSlashCommand(commandMsg),
          model: async (command, commandMsg) =>
            deps.commands.handleModelSlashCommand(command, commandMsg),
          newConversation: async (_command, commandMsg) =>
            deps.commands.handleNewConversationSlashCommand(commandMsg),
          pause: async () =>
            deps.commands.handlePauseResumeSlashCommand("pause", msg),
          reflection: async (_command, commandMsg) =>
            deps.commands.handleReflectionSlashCommand(commandMsg),
          reload: async (_command, commandMsg) =>
            deps.commands.handleReloadSlashCommand(commandMsg),
          resume: async () =>
            deps.commands.handlePauseResumeSlashCommand("resume", msg),
        },
        enableBangCommands: msg.channel === "slack" && msg.isMention === true,
      })
    ) {
      return;
    }

    if (!config) return;

    if (msg.channel === "slack" && isSlackChannelAccount(config)) {
      const slackResult = await deps.routes.ensureSlackRoute(
        adapter,
        msg,
        config,
      );
      if (!slackResult) {
        return;
      }
      const turnSource = buildChannelTurnSource(slackResult.route, msg);
      if (slackResult.route.outboundEnabled !== false) {
        await deps.dispatchTurnLifecycleEvent({
          type: "queued",
          source: turnSource,
        });
      }
      const preparedMessage = adapter.prepareInboundMessage
        ? await adapter.prepareInboundMessage(msg, {
            isFirstRouteTurn: slackResult.isFirstRouteTurn,
          })
        : msg;
      deps.deliver({
        route: slackResult.route,
        content: formatChannelNotification(preparedMessage),
        turnSources: [turnSource],
        defaultPermissionMode: config.defaultPermissionMode,
      });
      return;
    }

    // Telegram groups/supergroups can be used as public channel surfaces.
    // DMs keep the older explicit pairing flow below; group topics route by
    // chat_id + message_thread_id, which makes forum mode a surprisingly sane
    // threading primitive. Telegram, accidentally doing something useful.
    if (
      msg.channel === "telegram" &&
      isTelegramChannelAccount(config) &&
      msg.chatType === "channel"
    ) {
      if ((config.groupMode ?? "open") === "mention-only" && !msg.isMention) {
        return;
      }
      const telegramResult = await deps.routes.ensureTelegramRoute(
        adapter,
        msg,
        config,
      );
      if (!telegramResult) {
        return;
      }

      deps.deliver({
        route: telegramResult.route,
        content: formatChannelNotification(msg),
        turnSources: [buildChannelTurnSource(telegramResult.route, msg)],
      });
      return;
    }

    // Discord guild messages and account-bound DMs use auto-routing (like
    // Slack). DMs configured with explicit pairing fall through to the
    // standard pairing flow below.
    if (
      msg.channel === "discord" &&
      isDiscordChannelAccount(config) &&
      (msg.chatType === "channel" || config.dmPolicy !== "pairing")
    ) {
      const discordResult = await deps.routes.ensureDiscordRoute(
        adapter,
        msg,
        config,
      );
      if (!discordResult) {
        return;
      }

      // Delivery-time re-check: if allowed_channels changed since route creation,
      // drop the message (route cleanup, if desired, is handled separately by
      // reconcile + removeStaleRoutes).
      if (msg.chatType === "channel" && config.allowedChannels) {
        const isAllowed = isDiscordGuildChannelAllowed({
          channelId: msg.chatId,
          parentChannelId: msg.parentChannelId ?? null,
          isThread: !!(msg.threadId && msg.threadId === msg.chatId),
          allowedChannels: config.allowedChannels,
        });
        if (!isAllowed) {
          const resolvedParentId = msg.parentChannelId ?? null;
          const isThread = !!(msg.threadId && msg.threadId === msg.chatId);
          console.log(
            "[Discord] Delivery blocked by allowed_channels policy:",
            JSON.stringify({
              accountId: msg.accountId ?? config.accountId,
              chatId: msg.chatId,
              threadId: msg.threadId,
              resolvedParentId,
              reason: isThread
                ? `Thread "${msg.chatId}" parent channel "${resolvedParentId}" is not in allowed_channels`
                : `Guild channel "${msg.chatId}" is not in allowed_channels`,
            }),
          );
          return;
        }
      }

      const preparedMessage = adapter.prepareInboundMessage
        ? await adapter.prepareInboundMessage(msg, {
            isFirstRouteTurn: discordResult.isFirstRouteTurn,
          })
        : msg;
      deps.deliver({
        route: discordResult.route,
        content: formatChannelNotification(preparedMessage),
        turnSources: [
          buildChannelTurnSource(discordResult.route, preparedMessage),
        ],
      });
      return;
    }

    // WhatsApp sends through a linked human account, so the adapter performs
    // the conservative self-chat/group gates before messages reach here.
    // Direct chats can auto-route when not using pairing; groups auto-route
    // through the account binding.
    if (
      msg.channel === "whatsapp" &&
      isWhatsAppChannelAccount(config) &&
      (msg.chatType === "channel" || config.dmPolicy !== "pairing")
    ) {
      const whatsappResult = await deps.routes.ensureWhatsAppRoute(
        adapter,
        msg,
        config,
      );
      if (!whatsappResult) {
        return;
      }
      const preparedMessage = adapter.prepareInboundMessage
        ? await adapter.prepareInboundMessage(msg, {
            isFirstRouteTurn: whatsappResult.isFirstRouteTurn,
          })
        : msg;
      deps.deliver({
        route: whatsappResult.route,
        content: formatChannelNotification(preparedMessage),
        turnSources: [
          buildChannelTurnSource(whatsappResult.route, preparedMessage),
        ],
      });
      return;
    }

    // Signal uses a linked signal-cli account. DMs can use pairing, but
    // account-bound DMs and configured groups auto-route like WhatsApp.
    if (
      msg.channel === "signal" &&
      isSignalChannelAccount(config) &&
      (msg.chatType === "channel" || config.dmPolicy !== "pairing")
    ) {
      const signalResult = await deps.routes.ensureSignalRoute(
        adapter,
        msg,
        config,
      );
      if (!signalResult) {
        return;
      }
      const preparedMessage = adapter.prepareInboundMessage
        ? await adapter.prepareInboundMessage(msg, {
            isFirstRouteTurn: signalResult.isFirstRouteTurn,
          })
        : msg;
      deps.deliver({
        route: signalResult.route,
        content: formatChannelNotification(preparedMessage),
        turnSources: [
          buildChannelTurnSource(signalResult.route, preparedMessage),
        ],
      });
      return;
    }

    // 1. Check pairing/allowlist policy.
    if (await rejectByDmPolicy(adapter, msg, config, accountId)) {
      return;
    }

    // 2. Route lookup (reload from disk on miss — allows standalone CLI pairing)
    let route = getRouteFromStore(
      msg.channel,
      msg.chatId,
      accountId,
      msg.threadId,
    );
    if (!route) {
      loadRoutes(msg.channel);
      route = getRouteFromStore(
        msg.channel,
        msg.chatId,
        accountId,
        msg.threadId,
      );
    }
    if (!route) {
      await adapter.sendDirectReply(
        msg.chatId,
        buildUnboundRouteInstructions(msg.channel, msg.chatId),
      );
      return;
    }

    // 3. Let adapters enrich inbound messages (e.g. thread context,
    // transcription, attachment hydration), then format as XML/content parts.
    const preparedMessage = adapter.prepareInboundMessage
      ? await adapter.prepareInboundMessage(msg, { isFirstRouteTurn: false })
      : msg;
    const content = formatChannelNotification(preparedMessage);

    // 4. Deliver or buffer
    deps.deliver({
      route,
      content,
      turnSources: [buildChannelTurnSource(route, preparedMessage)],
    });
  }

  return { handleInboundMessage };
}

export type ChannelInboundRouter = ReturnType<
  typeof createChannelInboundRouter
>;
