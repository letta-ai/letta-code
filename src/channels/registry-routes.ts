import { getBackend } from "@/backend";
import { LEGACY_CHANNEL_ACCOUNT_ID } from "./accounts";
import type { ChannelRegistryEvent } from "./registry-events";
import {
  buildDirectReplyOptions,
  buildDiscordConversationSummary,
  buildSignalConversationSummary,
  buildSlackAppSetupInstructions,
  buildSlackConversationSummary,
  buildTelegramConversationSummary,
  buildWhatsAppConversationSummary,
} from "./registry-presentation";
import { addRoute, getRoute as getRouteFromStore, loadRoutes } from "./routing";
import { loadTargetStore, upsertChannelTarget } from "./targets";
import type {
  ChannelAdapter,
  ChannelRoute,
  DiscordChannelAccount,
  InboundChannelMessage,
  SignalChannelAccount,
  SlackChannelAccount,
  TelegramChannelAccount,
  WhatsAppChannelAccount,
} from "./types";

export function createChannelRouteProvisioner(deps: {
  emitEvent: (event: ChannelRegistryEvent) => void;
}) {
  async function createConversationForAgent(
    agentId: string,
    summary?: string,
  ): Promise<string> {
    const conversation = await getBackend().createConversation({
      agent_id: agentId,
      ...(summary ? { summary } : {}),
    });
    return conversation.id;
  }

  async function createSlackRoute(
    config: SlackChannelAccount,
    msg: InboundChannelMessage,
    options: { outboundEnabled?: boolean; detached?: boolean } = {},
  ): Promise<ChannelRoute> {
    if (!config.agentId) {
      throw new Error("Slack app is missing an agent binding.");
    }

    const conversationId = await createConversationForAgent(
      config.agentId,
      buildSlackConversationSummary(msg),
    );
    const now = new Date().toISOString();
    const route: ChannelRoute = {
      accountId: config.accountId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      threadId:
        msg.chatType === "channel"
          ? (msg.threadId ?? msg.messageId ?? null)
          : (msg.threadId ?? null),
      agentId: config.agentId,
      conversationId,
      enabled: true,
      outboundEnabled: options.outboundEnabled !== false,
      detached: options.detached === true,
      createdAt: now,
      updatedAt: now,
    };

    addRoute(msg.channel, route);
    deps.emitEvent({
      type: "slack_conversation_created",
      channelId: "slack",
      accountId: config.accountId,
      agentId: config.agentId,
      conversationId,
      defaultPermissionMode: config.defaultPermissionMode,
    });
    return route;
  }

  async function ensureSlackRoute(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    config: SlackChannelAccount,
  ): Promise<{
    route: ChannelRoute;
    isFirstRouteTurn: boolean;
  } | null> {
    if (!config.agentId) {
      if (msg.chatType === "channel" && msg.isMention !== true) {
        return null;
      }
      await adapter.sendDirectReply(
        msg.chatId,
        buildSlackAppSetupInstructions(),
        buildDirectReplyOptions(msg),
      );
      return null;
    }

    // Sender access (dmPolicy/allowedUsers, admin and env grants, pairing)
    // is enforced centrally in registry-inbound before provisioning runs.

    const accountId = msg.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    const routeThreadId =
      msg.channel === "slack" ? (msg.threadId ?? null) : null;
    let route = getRouteFromStore(
      msg.channel,
      msg.chatId,
      accountId,
      routeThreadId,
    );
    if (!route) {
      loadRoutes(msg.channel);
      route = getRouteFromStore(
        msg.channel,
        msg.chatId,
        accountId,
        routeThreadId,
      );
    }

    if (route) {
      if (
        msg.chatType === "channel" &&
        msg.isMention === true &&
        (route.outboundEnabled === false || route.detached === true)
      ) {
        const updatedRoute: ChannelRoute = {
          ...route,
          outboundEnabled: true,
          detached: false,
          updatedAt: new Date().toISOString(),
        };
        addRoute(msg.channel, updatedRoute);
        return {
          route: updatedRoute,
          isFirstRouteTurn: false,
        };
      }
      return {
        route,
        isFirstRouteTurn: false,
      };
    }

    const shouldCreateListenOnlyRoute =
      msg.chatType === "channel" &&
      msg.isMention !== true &&
      config.listenMode === true;

    if (
      msg.chatType === "channel" &&
      msg.isMention !== true &&
      !shouldCreateListenOnlyRoute
    ) {
      return null;
    }

    const now = new Date().toISOString();
    loadTargetStore(msg.channel);
    upsertChannelTarget(msg.channel, {
      accountId,
      targetId: msg.chatId,
      targetType: "channel",
      chatId: msg.chatId,
      label: msg.chatLabel ?? `Slack channel ${msg.chatId}`,
      discoveredAt: now,
      lastSeenAt: now,
      lastMessageId: msg.messageId,
    });
    deps.emitEvent({
      type: "targets_updated",
      channelId: msg.channel,
    });

    return {
      route: await createSlackRoute(config, msg, {
        outboundEnabled: !shouldCreateListenOnlyRoute,
      }),
      isFirstRouteTurn: true,
    };
  }

  async function createTelegramRoute(
    config: TelegramChannelAccount,
    msg: InboundChannelMessage,
  ): Promise<ChannelRoute> {
    if (!config.binding.agentId) {
      throw new Error("Telegram bot is missing an agent binding.");
    }

    const conversationId = await createConversationForAgent(
      config.binding.agentId,
      buildTelegramConversationSummary(msg),
    );
    const now = new Date().toISOString();
    const route: ChannelRoute = {
      accountId: config.accountId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      threadId: msg.threadId ?? null,
      agentId: config.binding.agentId,
      conversationId,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    addRoute(msg.channel, route);
    return route;
  }

  async function ensureTelegramRoute(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    config: TelegramChannelAccount,
  ): Promise<{
    route: ChannelRoute;
    isFirstRouteTurn: boolean;
  } | null> {
    if (!config.binding.agentId) {
      await adapter.sendDirectReply(
        msg.chatId,
        "This Telegram bot isn't connected to a Letta agent yet.\n\n" +
          "Open Channels > Telegram in Letta Code, choose which agent this bot should represent, and try again.",
        msg.messageId ? { replyToMessageId: msg.messageId } : undefined,
      );
      return null;
    }

    const accountId = msg.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    const routeThreadId = msg.threadId ?? null;
    let route = getRouteFromStore(
      msg.channel,
      msg.chatId,
      accountId,
      routeThreadId,
    );
    if (!route) {
      loadRoutes(msg.channel);
      route = getRouteFromStore(
        msg.channel,
        msg.chatId,
        accountId,
        routeThreadId,
      );
    }

    if (route) {
      return { route, isFirstRouteTurn: false };
    }

    const now = new Date().toISOString();
    loadTargetStore(msg.channel);
    upsertChannelTarget(msg.channel, {
      accountId,
      targetId: msg.threadId ? `${msg.chatId}:${msg.threadId}` : msg.chatId,
      targetType: "channel",
      chatId: msg.chatId,
      label: msg.chatLabel ?? `Telegram chat ${msg.chatId}`,
      discoveredAt: now,
      lastSeenAt: now,
      lastMessageId: msg.messageId,
    });
    deps.emitEvent({
      type: "targets_updated",
      channelId: msg.channel,
    });

    return {
      route: await createTelegramRoute(config, msg),
      isFirstRouteTurn: true,
    };
  }

  async function createDiscordRoute(
    config: DiscordChannelAccount,
    msg: InboundChannelMessage,
  ): Promise<ChannelRoute> {
    if (!config.agentId) {
      throw new Error("Discord bot is missing an agent binding.");
    }

    const conversationId = await createConversationForAgent(
      config.agentId,
      buildDiscordConversationSummary(msg),
    );
    const now = new Date().toISOString();
    const route: ChannelRoute = {
      accountId: config.accountId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      threadId: msg.threadId ?? null,
      agentId: config.agentId,
      conversationId,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    addRoute(msg.channel, route);
    deps.emitEvent({
      type: "discord_conversation_created",
      channelId: "discord",
      accountId: config.accountId,
      agentId: config.agentId,
      conversationId,
      defaultPermissionMode: config.defaultPermissionMode,
    });
    return route;
  }

  async function ensureDiscordRoute(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    config: DiscordChannelAccount,
  ): Promise<{
    route: ChannelRoute;
    isFirstRouteTurn: boolean;
  } | null> {
    if (!config.agentId) {
      if (msg.chatType === "direct" || msg.isMention === true) {
        await adapter.sendDirectReply(
          msg.chatId,
          "This Discord bot isn't connected to a Letta agent yet.\n\n" +
            "Open Channels > Discord in Letta Code, choose which agent this bot should represent, and try again.",
        );
      }
      return null;
    }

    // Sender access is enforced centrally in registry-inbound.

    const accountId = msg.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    const routeThreadId = msg.threadId ?? null;
    let route = getRouteFromStore(
      msg.channel,
      msg.chatId,
      accountId,
      routeThreadId,
    );
    if (!route) {
      loadRoutes(msg.channel);
      route = getRouteFromStore(
        msg.channel,
        msg.chatId,
        accountId,
        routeThreadId,
      );
    }

    if (route) {
      return { route, isFirstRouteTurn: false };
    }

    // In guild channels, only create routes from explicit mentions or
    // policy-permitted open-channel traffic.
    // Existing routed threads continue above via the route lookup path.
    if (msg.chatType === "channel" && !msg.isMention && !msg.isOpenChannel) {
      return null;
    }

    return {
      route: await createDiscordRoute(config, msg),
      isFirstRouteTurn: true,
    };
  }

  async function createWhatsAppRoute(
    config: WhatsAppChannelAccount,
    msg: InboundChannelMessage,
  ): Promise<ChannelRoute> {
    if (!config.agentId) {
      throw new Error("WhatsApp account is missing an agent binding.");
    }

    const conversationId = await createConversationForAgent(
      config.agentId,
      buildWhatsAppConversationSummary(msg),
    );
    const now = new Date().toISOString();
    const route: ChannelRoute = {
      accountId: config.accountId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      threadId: null,
      agentId: config.agentId,
      conversationId,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    addRoute(msg.channel, route);
    return route;
  }

  async function ensureWhatsAppRoute(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    config: WhatsAppChannelAccount,
  ): Promise<{
    route: ChannelRoute;
    isFirstRouteTurn: boolean;
  } | null> {
    if (!config.agentId) {
      if (msg.chatType !== "channel" || msg.isMention) {
        await adapter.sendDirectReply(
          msg.chatId,
          "This WhatsApp account isn't connected to a Letta agent yet.\n\n" +
            "Open Channels > WhatsApp in Letta Code, choose which agent this WhatsApp account should represent, and try again.",
        );
      }
      return null;
    }

    // Sender access is enforced centrally in registry-inbound.

    const accountId = msg.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    let route = getRouteFromStore(msg.channel, msg.chatId, accountId, null);
    if (!route) {
      loadRoutes(msg.channel);
      route = getRouteFromStore(msg.channel, msg.chatId, accountId, null);
    }

    if (route) {
      return { route, isFirstRouteTurn: false };
    }

    if (msg.chatType === "channel") {
      const now = new Date().toISOString();
      loadTargetStore(msg.channel);
      upsertChannelTarget(msg.channel, {
        accountId,
        targetId: msg.chatId,
        targetType: "channel",
        chatId: msg.chatId,
        label: msg.chatLabel ?? `WhatsApp group ${msg.chatId}`,
        discoveredAt: now,
        lastSeenAt: now,
        lastMessageId: msg.messageId,
      });
      deps.emitEvent({
        type: "targets_updated",
        channelId: msg.channel,
      });
    }

    return {
      route: await createWhatsAppRoute(config, msg),
      isFirstRouteTurn: true,
    };
  }

  async function createSignalRoute(
    config: SignalChannelAccount,
    msg: InboundChannelMessage,
  ): Promise<ChannelRoute> {
    if (!config.agentId) {
      throw new Error("Signal account is missing an agent binding.");
    }

    const conversationId = await createConversationForAgent(
      config.agentId,
      buildSignalConversationSummary(msg),
    );
    const now = new Date().toISOString();
    const route: ChannelRoute = {
      accountId: config.accountId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      threadId: null,
      agentId: config.agentId,
      conversationId,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    addRoute(msg.channel, route);
    return route;
  }

  async function ensureSignalRoute(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    config: SignalChannelAccount,
  ): Promise<{
    route: ChannelRoute;
    isFirstRouteTurn: boolean;
  } | null> {
    if (!config.agentId) {
      if (!msg.reaction && (msg.chatType !== "channel" || msg.isMention)) {
        await adapter.sendDirectReply(
          msg.chatId,
          "This Signal account isn't connected to a Letta agent yet.\n\n" +
            "Open Channels > Signal in Letta Code, choose which agent this Signal account should represent, and try again.",
        );
      }
      return null;
    }

    // Sender access is enforced centrally in registry-inbound.

    const accountId = msg.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    let route = getRouteFromStore(msg.channel, msg.chatId, accountId, null);
    if (!route) {
      loadRoutes(msg.channel);
      route = getRouteFromStore(msg.channel, msg.chatId, accountId, null);
    }

    if (route) {
      return { route, isFirstRouteTurn: false };
    }

    if (msg.chatType === "channel") {
      const now = new Date().toISOString();
      loadTargetStore(msg.channel);
      upsertChannelTarget(msg.channel, {
        accountId,
        targetId: msg.chatId,
        targetType: "channel",
        chatId: msg.chatId,
        label: msg.chatLabel ?? `Signal group ${msg.chatId}`,
        discoveredAt: now,
        lastSeenAt: now,
        lastMessageId: msg.messageId,
      });
      deps.emitEvent({
        type: "targets_updated",
        channelId: msg.channel,
      });
    }

    return {
      route: await createSignalRoute(config, msg),
      isFirstRouteTurn: true,
    };
  }

  return {
    createConversationForAgent,
    createSlackRoute,
    ensureSlackRoute,
    ensureTelegramRoute,
    ensureDiscordRoute,
    ensureWhatsAppRoute,
    ensureSignalRoute,
  };
}

export type ChannelRouteProvisioner = ReturnType<
  typeof createChannelRouteProvisioner
>;
