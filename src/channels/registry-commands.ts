import { buildChatUrl, isLocalAgentId } from "@/cli/helpers/app-urls";
import { getChannelAccount, LEGACY_CHANNEL_ACCOUNT_ID } from "./accounts";
import {
  buildChannelAlreadyActiveMessage,
  buildChannelAlreadyDetachedMessage,
  buildChannelAlreadyPausedMessage,
  buildChannelCancelNoActiveTurnMessage,
  buildChannelCancelUnavailableMessage,
  buildChannelChatLinkMessage,
  buildChannelChatUnavailableMessage,
  buildChannelDetachedMessage,
  buildChannelDetachUnsupportedMessage,
  buildChannelModelUnavailableMessage,
  buildChannelNewConversationMessage,
  buildChannelNewConversationUnavailableMessage,
  buildChannelNoRouteMessage,
  buildChannelPausedMessage,
  buildChannelReflectionUnavailableMessage,
  buildChannelReloadUnavailableMessage,
  buildChannelResumedMessage,
} from "./commands";
import type { ChannelRegistryEvent } from "./registry-events";
import type {
  ChannelCancelHandler,
  ChannelModelHandler,
  ChannelReflectionHandler,
  ChannelReloadHandler,
} from "./registry-handlers";
import { buildSlackConversationSummary } from "./registry-presentation";
import type { ChannelRouteProvisioner } from "./registry-routes";
import {
  addRoute,
  getRoute as getRouteFromStore,
  getRouteRaw,
  getRoutesForChannel,
  loadRoutes,
} from "./routing";
import type {
  ChannelAccount,
  ChannelModelPickerData,
  ChannelRoute,
  InboundChannelMessage,
} from "./types";
import { isSlackChannelAccount } from "./types";

export function createChannelCommandRouter(deps: {
  routes: ChannelRouteProvisioner;
  emitEvent: (event: ChannelRegistryEvent) => void;
  getRoute: (
    channel: string,
    chatId: string,
    accountId?: string,
    threadId?: string | null,
  ) => ChannelRoute | null;
  getCancelHandler: () => ChannelCancelHandler | null;
  getReflectionHandler: () => ChannelReflectionHandler | null;
  getReloadHandler: () => ChannelReloadHandler | null;
  getModelHandler: () => ChannelModelHandler | null;
}) {
  function findRawRouteForMessage(
    msg: InboundChannelMessage,
  ): ChannelRoute | null {
    return (
      getRouteRaw(msg.channel, msg.chatId, msg.accountId, msg.threadId) ?? null
    );
  }

  function loadAndFindRawRouteForMessage(
    msg: InboundChannelMessage,
  ): ChannelRoute | null {
    const route = findRawRouteForMessage(msg);
    if (route) {
      return route;
    }
    loadRoutes(msg.channel);
    return findRawRouteForMessage(msg);
  }

  async function handlePauseResumeSlashCommand(
    commandName: "pause" | "resume",
    msg: InboundChannelMessage,
  ): Promise<{ handled: boolean; text?: string }> {
    const route = loadAndFindRawRouteForMessage(msg);
    if (!route) {
      return {
        handled: true,
        text: buildChannelNoRouteMessage(msg.channel),
      };
    }

    if (commandName === "pause") {
      if (route.enabled === false) {
        return {
          handled: true,
          text: buildChannelAlreadyPausedMessage(msg.channel),
        };
      }
      const updatedRoute: ChannelRoute = {
        ...route,
        enabled: false,
        updatedAt: new Date().toISOString(),
      };
      addRoute(msg.channel, updatedRoute);
      return {
        handled: true,
        text: buildChannelPausedMessage(msg.channel, updatedRoute),
      };
    }

    if (route.enabled !== false) {
      return {
        handled: true,
        text: buildChannelAlreadyActiveMessage(msg.channel),
      };
    }
    const updatedRoute: ChannelRoute = {
      ...route,
      enabled: true,
      updatedAt: new Date().toISOString(),
    };
    addRoute(msg.channel, updatedRoute);
    return {
      handled: true,
      text: buildChannelResumedMessage(msg.channel, updatedRoute),
    };
  }

  async function handleCancelSlashCommand(
    msg: InboundChannelMessage,
  ): Promise<{ handled: boolean; text?: string }> {
    const route = getCancelRoute(msg);
    const cancelHandler = deps.getCancelHandler();
    if (!route?.enabled || !cancelHandler) {
      return {
        handled: true,
        text: buildChannelCancelUnavailableMessage(msg.channel),
      };
    }

    const cancelled = await cancelHandler({
      runtime: {
        agent_id: route.agentId,
        conversation_id: route.conversationId,
      },
    });

    if (!cancelled) {
      return {
        handled: true,
        text: buildChannelCancelNoActiveTurnMessage(msg.channel),
      };
    }

    return { handled: true };
  }

  async function handleChatSlashCommand(
    msg: InboundChannelMessage,
  ): Promise<{ handled: boolean; text?: string }> {
    const route = loadAndFindRawRouteForMessage(msg);
    if (!route) {
      return {
        handled: true,
        text: buildChannelNoRouteMessage(msg.channel),
      };
    }

    if (isLocalAgentId(route.agentId)) {
      return {
        handled: true,
        text: buildChannelChatUnavailableMessage(msg.channel, route),
      };
    }

    return {
      handled: true,
      text: buildChannelChatLinkMessage(
        msg.channel,
        route,
        buildChatUrl(route.agentId, {
          conversationId: route.conversationId,
        }),
      ),
    };
  }

  async function handleDetachSlashCommand(
    msg: InboundChannelMessage,
  ): Promise<{ handled: boolean; text?: string }> {
    if (
      msg.channel !== "slack" ||
      msg.chatType !== "channel" ||
      !msg.threadId
    ) {
      return {
        handled: true,
        text: buildChannelDetachUnsupportedMessage(msg.channel),
      };
    }

    const existingRoute = loadAndFindRawRouteForMessage(msg);
    if (existingRoute?.detached === true) {
      return {
        handled: true,
        text: buildChannelAlreadyDetachedMessage(msg.channel),
      };
    }

    const now = new Date().toISOString();
    if (existingRoute) {
      const updatedRoute: ChannelRoute = {
        ...existingRoute,
        enabled: true,
        outboundEnabled: false,
        detached: true,
        updatedAt: now,
      };
      addRoute(msg.channel, updatedRoute);
      return {
        handled: true,
        text: buildChannelDetachedMessage(msg.channel),
      };
    }

    const accountId = msg.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    const config = getChannelAccount(msg.channel, accountId);
    if (!config || !isSlackChannelAccount(config) || !config.agentId) {
      return {
        handled: true,
        text: buildChannelNoRouteMessage(msg.channel),
      };
    }

    await deps.routes.createSlackRoute(config, msg, {
      outboundEnabled: false,
      detached: true,
    });
    return {
      handled: true,
      text: buildChannelDetachedMessage(msg.channel),
    };
  }

  async function handleNewConversationSlashCommand(
    msg: InboundChannelMessage,
  ): Promise<{ handled: boolean; text?: string }> {
    if (msg.channel !== "slack") {
      return {
        handled: true,
        text: buildChannelNewConversationUnavailableMessage(msg.channel),
      };
    }

    const accountId = msg.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    const config = getChannelAccount(msg.channel, accountId);
    if (!config || !isSlackChannelAccount(config) || !config.agentId) {
      return {
        handled: true,
        text: buildChannelNewConversationUnavailableMessage(msg.channel),
      };
    }

    const existingRoute = loadAndFindRawRouteForMessage(msg);
    const agentId = existingRoute?.agentId ?? config.agentId;
    const conversationId = await deps.routes.createConversationForAgent(
      agentId,
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
          : null,
      agentId,
      conversationId,
      enabled: true,
      outboundEnabled: true,
      detached: false,
      createdAt: existingRoute?.createdAt ?? now,
      updatedAt: now,
    };

    addRoute(msg.channel, route);
    deps.emitEvent({
      type: "slack_conversation_created",
      channelId: "slack",
      accountId: config.accountId,
      agentId,
      conversationId,
      defaultPermissionMode: config.defaultPermissionMode,
    });

    return {
      handled: true,
      text: buildChannelNewConversationMessage(msg.channel, route),
    };
  }

  async function handleReflectionSlashCommand(
    msg: InboundChannelMessage,
  ): Promise<{ handled: boolean; text?: string }> {
    const route = loadAndFindRawRouteForMessage(msg);
    if (!route?.enabled) {
      return {
        handled: true,
        text: buildChannelNoRouteMessage(msg.channel),
      };
    }

    const reflectionHandler = deps.getReflectionHandler();
    if (!reflectionHandler) {
      return {
        handled: true,
        text: buildChannelReflectionUnavailableMessage(msg.channel),
      };
    }

    return reflectionHandler({
      runtime: {
        agent_id: route.agentId,
        conversation_id: route.conversationId,
      },
    });
  }

  async function handleReloadSlashCommand(
    msg: InboundChannelMessage,
  ): Promise<{ handled: boolean; text?: string }> {
    const route = loadAndFindRawRouteForMessage(msg);
    if (!route?.enabled) {
      return {
        handled: true,
        text: buildChannelNoRouteMessage(msg.channel),
      };
    }

    const reloadHandler = deps.getReloadHandler();
    if (!reloadHandler) {
      return {
        handled: true,
        text: buildChannelReloadUnavailableMessage(msg.channel),
      };
    }

    return reloadHandler({
      runtime: {
        agent_id: route.agentId,
        conversation_id: route.conversationId,
      },
    });
  }

  async function handleModelSlashCommand(
    command: { args: string },
    msg: InboundChannelMessage,
  ): Promise<{
    handled: boolean;
    text?: string;
    modelPicker?: ChannelModelPickerData;
  }> {
    const route = loadAndFindRawRouteForMessage(msg);
    if (!route) {
      return {
        handled: true,
        text: buildChannelNoRouteMessage(msg.channel),
      };
    }

    const modelHandler = deps.getModelHandler();
    if (!modelHandler) {
      return {
        handled: true,
        text: buildChannelModelUnavailableMessage(msg.channel),
      };
    }

    return modelHandler({
      channelId: msg.channel,
      runtime: {
        agent_id: route.agentId,
        conversation_id: route.conversationId,
      },
      modelIdentifier: command.args || undefined,
    });
  }

  function getCancelRoute(msg: InboundChannelMessage): ChannelRoute | null {
    let route = deps.getRoute(
      msg.channel,
      msg.chatId,
      msg.accountId,
      msg.threadId,
    );
    if (route) {
      return route;
    }

    loadRoutes(msg.channel);
    route = deps.getRoute(msg.channel, msg.chatId, msg.accountId, msg.threadId);
    if (route) {
      return route;
    }

    if (
      msg.channel !== "slack" ||
      msg.chatType !== "channel" ||
      msg.threadId != null
    ) {
      return null;
    }

    const accountId = msg.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    const matches = getRoutesForChannel(msg.channel, accountId).filter(
      (candidate) =>
        candidate.chatId === msg.chatId &&
        candidate.chatType === "channel" &&
        candidate.enabled,
    );

    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  function getExactEnabledRouteForMessage(
    msg: InboundChannelMessage,
    accountId: string,
  ): ChannelRoute | null {
    const existingRoute = getRouteFromStore(
      msg.channel,
      msg.chatId,
      accountId,
      msg.threadId,
    );
    if (existingRoute) {
      return existingRoute;
    }

    loadRoutes(msg.channel);
    return getRouteFromStore(msg.channel, msg.chatId, accountId, msg.threadId);
  }

  function shouldDropUnroutedSlackThreadInput(
    msg: InboundChannelMessage,
    accountId: string,
    config: ChannelAccount | null,
  ): boolean {
    if (
      msg.channel !== "slack" ||
      msg.chatType !== "channel" ||
      msg.threadId == null ||
      msg.isMention === true
    ) {
      return false;
    }

    const exactRoute = getExactEnabledRouteForMessage(msg, accountId);
    if (exactRoute?.detached === true) {
      return true;
    }

    return (
      (!config ||
        !isSlackChannelAccount(config) ||
        config.listenMode !== true) &&
      !exactRoute
    );
  }

  return {
    handleCancelSlashCommand,
    handleChatSlashCommand,
    handleDetachSlashCommand,
    handleModelSlashCommand,
    handleNewConversationSlashCommand,
    handlePauseResumeSlashCommand,
    handleReflectionSlashCommand,
    handleReloadSlashCommand,
    shouldDropUnroutedSlackThreadInput,
  };
}

export type ChannelCommandRouter = ReturnType<
  typeof createChannelCommandRouter
>;
