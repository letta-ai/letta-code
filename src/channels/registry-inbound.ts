import { debugLog } from "@/utils/debug";
import {
  buildChannelAccessDeniedMessage,
  evaluateChannelSenderAccess,
  floorOnlyChannelCommandGate,
  resolveChannelAccessScope,
  resolveChannelCommandGate,
} from "./access-control";
import { getChannelAccount, LEGACY_CHANNEL_ACCOUNT_ID } from "./accounts";
import { tryHandleChannelSlashCommand } from "./commands";
import { isDiscordGuildChannelAllowed } from "./discord/channel-gating";
import { createPairingCode } from "./pairing";
import type { ChannelCommandRouter } from "./registry-commands";
import type { ChannelControlRequests } from "./registry-controls";
import type { ChannelRegistryEvent } from "./registry-events";
import type { ChannelInboundDelivery } from "./registry-handlers";
import {
  buildChannelTurnSource,
  buildDirectReplyOptions,
  buildPairingInstructions,
  buildUnboundRouteInstructions,
  getConfiguredAgentId,
} from "./registry-presentation";
import type { ChannelRouteProvisioner } from "./registry-routes";
import { loadRouteForInboundMessage } from "./routing";
import type {
  ChannelAdapter,
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
  async function handleInboundMessage(
    msg: InboundChannelMessage,
  ): Promise<void> {
    const accountId = msg.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    const adapter = deps.getAdapter(msg.channel, accountId);
    if (!adapter) return;

    const config = getChannelAccount(msg.channel, accountId);

    const senderAccess = config
      ? evaluateChannelSenderAccess({
          account: config,
          channelId: msg.channel,
          senderId: msg.senderId,
          chatType: msg.chatType,
        })
      : null;
    if (senderAccess === "deny") {
      if (msg.reaction) {
        return;
      }
      if (resolveChannelAccessScope(msg.chatType) === "dm") {
        await adapter.sendDirectReply(
          msg.chatId,
          buildChannelAccessDeniedMessage(msg.channel),
          buildDirectReplyOptions(msg),
        );
      } else {
        debugLog(
          "channels",
          `Dropped ${msg.channel} group message from unauthorized sender ${msg.senderId} in chat ${msg.chatId}`,
        );
      }
      return;
    }

    if (await deps.controls.tryHandleInbound(adapter, msg)) {
      return;
    }

    const getStatusRoute = () => loadRouteForInboundMessage(msg, accountId);

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
        commandGate: config
          ? senderAccess === "pair"
            ? floorOnlyChannelCommandGate()
            : resolveChannelCommandGate({
                account: config,
                channelId: msg.channel,
                senderId: msg.senderId,
              })
          : undefined,
      })
    ) {
      return;
    }

    if (
      deps.commands.shouldDropUnroutedSlackThreadInput(msg, accountId, config)
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
          debugLog(
            "Discord",
            "Delivery blocked by allowed_channels policy:",
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

      const isBareThreadMention =
        msg.isMention === true &&
        !!msg.threadId &&
        msg.text.trim().length === 0 &&
        (!msg.attachments || msg.attachments.length === 0);
      if (isBareThreadMention) {
        await adapter.sendDirectReply(
          msg.chatId,
          discordResult.isFirstRouteTurn
            ? "This thread is connected now. Send a message here to continue."
            : "This thread is already connected. Send a message here to continue.",
          buildDirectReplyOptions(msg),
        );
        return;
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
        defaultPermissionMode: config.defaultPermissionMode,
      });
      return;
    }

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

    if (senderAccess === "pair") {
      if (msg.reaction) {
        return;
      }
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
        buildDirectReplyOptions(msg),
      );
      return;
    }

    const route = loadRouteForInboundMessage(msg, accountId);
    if (!route) {
      if (msg.reaction) {
        return;
      }
      await adapter.sendDirectReply(
        msg.chatId,
        buildUnboundRouteInstructions(msg.channel, msg.chatId),
        buildDirectReplyOptions(msg),
      );
      return;
    }

    const preparedMessage = adapter.prepareInboundMessage
      ? await adapter.prepareInboundMessage(msg, { isFirstRouteTurn: false })
      : msg;
    const content = formatChannelNotification(preparedMessage);

    deps.deliver({
      route,
      content,
      turnSources: [buildChannelTurnSource(route, preparedMessage)],
      ...(isDiscordChannelAccount(config) || isSlackChannelAccount(config)
        ? { defaultPermissionMode: config.defaultPermissionMode }
        : {}),
    });
  }

  return { handleInboundMessage };
}

export type ChannelInboundRouter = ReturnType<
  typeof createChannelInboundRouter
>;
