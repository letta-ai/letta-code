import {
  buildChannelAccessDeniedMessage,
  evaluateChannelSenderAccess,
  floorOnlyChannelCommandGate,
  resolveChannelAccessScope,
  resolveChannelCommandGate,
} from "./access-control";
import { getChannelAccount, LEGACY_CHANNEL_ACCOUNT_ID } from "./accounts";
import type { ChannelStatusContext } from "./channel-status";
import { tryHandleChannelSlashCommand } from "./commands";
import { isDiscordGuildChannelAllowed } from "./discord/channel-gating";
import { createPairingCode } from "./pairing";
import type { ChannelCommandRouter } from "./registry-commands";
import type { ChannelControlRequests } from "./registry-controls";
import type { ChannelRegistryEvent } from "./registry-events";
import type {
  ChannelInboundDelivery,
  ChannelModelStatusHandler,
} from "./registry-handlers";
import {
  buildChannelTurnSource,
  buildPairingInstructions,
  buildUnboundRouteInstructions,
  getConfiguredAgentId,
} from "./registry-presentation";
import type { ChannelRouteProvisioner } from "./registry-routes";
import { getRoute as getRouteFromStore, loadRoutes } from "./routing";
import type {
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

export async function buildInboundChannelStatusContext(params: {
  adapter: ChannelAdapter;
  accountConfigured: boolean;
  accountEnabled?: boolean;
  route: ChannelRoute | null;
  resolveModelStatus?: ChannelModelStatusHandler;
}): Promise<ChannelStatusContext> {
  let activeModel: ChannelStatusContext["activeModel"];

  if (params.route && params.resolveModelStatus) {
    try {
      const status = await params.resolveModelStatus({
        agentId: params.route.agentId,
        conversationId: params.route.conversationId,
      });
      activeModel = {
        modelLabel: status.modelLabel,
        modelHandle: status.modelHandle,
      };
    } catch {
      // Best-effort; status still works when model lookup is unavailable.
    }
  }

  return {
    adapterRunning: params.adapter.isRunning(),
    accountConfigured: params.accountConfigured,
    accountEnabled: params.accountEnabled,
    route: params.route,
    activeModel,
  };
}

export function createChannelInboundRouter(deps: {
  controls: ChannelControlRequests;
  commands: ChannelCommandRouter;
  routes: ChannelRouteProvisioner;
  getModelStatusHandler: () => ChannelModelStatusHandler | null;
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

    // Sender access gate: one decision for every surface (DMs, groups,
    // and every channel's auto-route path), evaluated before control
    // responses and slash commands so unauthorized senders cannot answer
    // approval prompts or run commands. "pair" senders continue so
    // read-only slash commands still work before pairing completes; the
    // pairing-code flow below handles their normal messages.
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
        );
      } else {
        console.log(
          `[channels] Dropped ${msg.channel} group message from unauthorized sender ${msg.senderId} in chat ${msg.chatId}`,
        );
      }
      return;
    }

    if (await deps.controls.tryHandleInbound(adapter, msg)) {
      return;
    }

    if (
      deps.commands.shouldDropUnroutedSlackThreadInput(msg, accountId, config)
    ) {
      return;
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

    const statusRoute = getStatusRoute();
    const statusContext: ChannelStatusContext = {
      adapterRunning: adapter.isRunning(),
      accountConfigured: !!config,
      accountEnabled: config?.enabled,
      route: statusRoute,
    };

    if (
      await tryHandleChannelSlashCommand(adapter, msg, {
        statusContext,
        resolveStatusContext: () => {
          const modelStatusHandler = deps.getModelStatusHandler();
          return buildInboundChannelStatusContext({
            adapter,
            accountConfigured: statusContext.accountConfigured,
            accountEnabled: statusContext.accountEnabled,
            route: statusRoute,
            resolveModelStatus: modelStatusHandler ?? undefined,
          });
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

    // 1. Pairing handshake: the sender access gate above already allowed
    // allowlisted/approved senders and denied blocked ones; "pair" means
    // this DM sender still needs a pairing code.
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
      );
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
