import type { ListModelsResponseModelEntry } from "@/types/protocol_v2";
import {
  buildChannelCommandDeniedMessage,
  buildChannelWhoamiMessage,
  type ChannelCommandGate,
  canonicalizeChannelCommandName,
  canRunChannelCommand,
} from "./access-control";
import {
  buildChannelCancelAcceptedMessage as buildChannelCancelAcceptedMessageWith,
  buildChannelCancelNoActiveTurnMessage as buildChannelCancelNoActiveTurnMessageWith,
  buildChannelCurrentModelMessage as buildChannelCurrentModelMessageWith,
  buildChannelCurrentModelUnavailableMessage as buildChannelCurrentModelUnavailableMessageWith,
  buildChannelModelListMessage as buildChannelModelListMessageWith,
  buildChannelModelListUnavailableMessage as buildChannelModelListUnavailableMessageWith,
  buildChannelModelUpdatedMessage as buildChannelModelUpdatedMessageWith,
  buildChannelModelUpdateFailedMessage as buildChannelModelUpdateFailedMessageWith,
} from "./command-runtime-executor";
import {
  buildChannelHelpMessage as buildChannelHelpMessageWith,
  buildUnsupportedChannelCommandMessage as buildUnsupportedChannelCommandMessageWith,
  type ChannelSlashCommandHandlerResult,
  type ChannelSlashCommandHandlers,
  isSupportedSlackMentionCommand,
  type ParsedChannelSlashCommand,
  parseChannelBangCommand,
  parseChannelSlashCommand,
} from "./command-surface";
import { handleChannelFeedbackCommand } from "./feedback";
import { getChannelDisplayName } from "./plugin-registry";
import { buildDirectReplyOptions } from "./registry-presentation";
import type {
  ChannelAdapter,
  ChannelModelPickerData,
  ChannelRoute,
  InboundChannelMessage,
} from "./types";

export type { ChannelModelListEntry } from "./command-runtime-executor";
export {
  buildChannelModelNotFoundText,
  buildModelEntriesByHandle,
  getFallbackModelEntries,
  resolveModelHandles,
} from "./command-runtime-executor";
export type {
  ChannelSlashCommandDefinition,
  ChannelSlashCommandHandlerResult,
  ChannelSlashCommandHandlers,
  ChannelSlashCommandKind,
  ParsedChannelSlashCommand,
} from "./command-surface";
export {
  listChannelSlashCommands,
  parseChannelBangCommand,
  parseChannelSlashCommand,
} from "./command-surface";

type ChannelDirectReplyPayload = {
  text: string;
  modelPicker?: ChannelModelPickerData;
};

export type ChannelStatusContext = {
  adapterRunning: boolean;
  accountConfigured: boolean;
  accountEnabled?: boolean;
  route: ChannelRoute | null;
};

export type ChannelSlashCommandOptions = {
  statusContext?: ChannelStatusContext;
  handlers?: ChannelSlashCommandHandlers;
  enableBangCommands?: boolean;
  /** Admin/user tier gate for this sender; undefined disables gating. */
  commandGate?: ChannelCommandGate;
};

function channelDisplayName(channelId: string): string {
  try {
    return getChannelDisplayName(channelId);
  } catch {
    return channelId;
  }
}

function isSlackMentionSlashCommand(
  msg: InboundChannelMessage,
  command: ParsedChannelSlashCommand,
): boolean {
  return (
    msg.channel === "slack" &&
    msg.isMention === true &&
    command.raw.startsWith("/")
  );
}

function isSlackMentionControlCommand(
  msg: InboundChannelMessage,
  command: ParsedChannelSlashCommand,
): boolean {
  return (
    command.raw.startsWith("!") || isSlackMentionSlashCommand(msg, command)
  );
}

export function buildChannelHelpMessage(channelId: string): string {
  return buildChannelHelpMessageWith(channelId, channelDisplayName);
}

export function buildUnsupportedChannelCommandMessage(
  channelId: string,
  command: ParsedChannelSlashCommand,
): string {
  return buildUnsupportedChannelCommandMessageWith(
    channelId,
    command,
    channelDisplayName,
  );
}

export function buildChannelStatusMessage(
  msg: InboundChannelMessage,
  context: ChannelStatusContext,
): string {
  const displayName = channelDisplayName(msg.channel);
  const route = context.route;
  const routeStatus = route
    ? "Connected to a Letta agent conversation."
    : "No route is connected for this chat yet.";
  const accountStatus = !context.accountConfigured
    ? "No channel account is configured for this receiver."
    : context.accountEnabled === false
      ? "Channel account is configured but disabled."
      : "Channel account is configured and enabled.";

  const lines = [
    `${displayName} status`,
    accountStatus,
    `Listener: ${context.adapterRunning ? "running" : "stopped"}.`,
    `Route: ${routeStatus}`,
  ];

  if (route) {
    lines.push(`Agent: ${route.agentId}.`);
    lines.push(`Conversation: ${route.conversationId}.`);
    if (route.threadId) {
      lines.push(`Thread: ${route.threadId}.`);
    }
    if (route.detached) {
      lines.push("Slack thread is detached until the app is mentioned again.");
    } else if (route.outboundEnabled === false) {
      lines.push(
        "Outbound replies are disabled until the app is mentioned again.",
      );
    }
  } else {
    lines.push(
      "Send a normal non-command message here to get pairing or connection instructions.",
    );
  }

  return lines.join("\n");
}

export function buildChannelNoRouteMessage(channelId: string): string {
  const displayName = channelDisplayName(channelId);
  return [
    `${displayName} could not find an existing route for this chat.`,
    "Send a normal message first and follow the pairing instructions, then try again.",
  ].join("\n\n");
}

export function buildChannelPausedMessage(
  channelId: string,
  route: ChannelRoute,
): string {
  const displayName = channelDisplayName(channelId);
  const conversation = route.conversationId
    ? ` Conversation: ${route.conversationId}.`
    : "";
  return `${displayName} paused agent routing for this chat.${conversation} Send /resume here to turn replies back on.`;
}

export function buildChannelAlreadyPausedMessage(channelId: string): string {
  return `${channelDisplayName(channelId)} agent routing is already paused for this chat. Send /resume here to turn replies back on.`;
}

export function buildChannelResumedMessage(
  channelId: string,
  route: ChannelRoute,
): string {
  const displayName = channelDisplayName(channelId);
  const conversation = route.conversationId
    ? ` Conversation: ${route.conversationId}.`
    : "";
  return `${displayName} resumed agent routing for this chat.${conversation} Normal messages here will go to the connected agent again.`;
}

export function buildChannelAlreadyActiveMessage(channelId: string): string {
  return `${channelDisplayName(channelId)} agent routing is already active for this chat.`;
}

export function buildChannelCancelUnavailableMessage(
  channelId: string,
): string {
  const displayName = channelDisplayName(channelId);
  return [
    `${displayName} received /cancel, but this chat is not connected to an active Letta Code conversation yet.`,
    "Send a normal message first to connect this chat to an agent.",
  ].join("\n\n");
}

export function buildChannelCancelNoActiveTurnMessage(
  channelId: string,
): string {
  return buildChannelCancelNoActiveTurnMessageWith(
    channelId,
    channelDisplayName,
  );
}

export function buildChannelCancelAcceptedMessage(channelId: string): string {
  return buildChannelCancelAcceptedMessageWith(channelId, channelDisplayName);
}

export function buildChannelChatLinkMessage(
  channelId: string,
  route: ChannelRoute,
  chatUrl: string,
): string {
  const displayName = channelDisplayName(channelId);
  return [
    `${displayName} chat for this route: ${chatUrl}`,
    `Agent: ${route.agentId}.`,
    `Conversation: ${route.conversationId}.`,
  ].join("\n");
}

export function buildChannelChatUnavailableMessage(
  channelId: string,
  route: ChannelRoute,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} chat UI is not available for local backend agent ${route.agentId}.`;
}

export function buildChannelDetachUnsupportedMessage(
  channelId: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} can only detach Slack channel threads.`;
}

export function buildChannelDetachedMessage(channelId: string): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} detached this thread. I will ignore follow-up replies here until someone mentions the app again.`;
}

export function buildChannelAlreadyDetachedMessage(channelId: string): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} is already detached from this thread. Mention the app again to reattach.`;
}

export function buildChannelNewConversationMessage(
  channelId: string,
  route: ChannelRoute,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} started a new conversation for this chat. Conversation: ${route.conversationId}.`;
}

export function buildChannelNewConversationUnavailableMessage(
  channelId: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} cannot start a new conversation for this chat because no agent is configured.`;
}

export function buildChannelCurrentModelMessage(
  channelId: string,
  params: {
    modelLabel: string;
    modelHandle: string | null;
    scope?: "agent" | "conversation";
  },
): string {
  return buildChannelCurrentModelMessageWith(
    channelId,
    params,
    channelDisplayName,
  );
}

export function buildChannelModelListMessage(
  channelId: string,
  params: {
    entries: ListModelsResponseModelEntry[];
    availableHandles?: string[] | null;
    recentHandles?: string[];
    limit?: number;
  },
): string {
  return buildChannelModelListMessageWith(
    channelId,
    params,
    channelDisplayName,
  );
}

export function buildChannelModelListUnavailableMessage(
  channelId: string,
  error: string,
): string {
  return buildChannelModelListUnavailableMessageWith(
    channelId,
    error,
    channelDisplayName,
  );
}

export function buildChannelCurrentModelUnavailableMessage(
  channelId: string,
  error: string,
): string {
  return buildChannelCurrentModelUnavailableMessageWith(
    channelId,
    error,
    channelDisplayName,
  );
}

export function buildChannelModelUpdatedMessage(
  channelId: string,
  params: {
    modelLabel: string;
    modelHandle: string;
    appliedTo?: "agent" | "conversation";
  },
): string {
  return buildChannelModelUpdatedMessageWith(
    channelId,
    params,
    channelDisplayName,
  );
}

export function buildChannelModelUpdateFailedMessage(
  channelId: string,
  identifier: string,
  error: string,
): string {
  return buildChannelModelUpdateFailedMessageWith(
    channelId,
    identifier,
    error,
    channelDisplayName,
  );
}

export function buildChannelModelUnavailableMessage(channelId: string): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} cannot use /model because the listener is not ready yet. Try again in a moment.`;
}

export function buildChannelReflectionUnavailableMessage(
  channelId: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} cannot start reflection for this chat because the listener is not ready yet. Try again in a moment.`;
}

export function buildChannelReloadUnavailableMessage(
  channelId: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} cannot reload settings, local mods, and agent secrets for this chat because the listener is not ready yet. Try again in a moment.`;
}

async function handleScopedCommand(params: {
  msg: InboundChannelMessage;
  command: ParsedChannelSlashCommand;
  handler:
    | ((
        command: ParsedChannelSlashCommand,
        msg: InboundChannelMessage,
      ) => Promise<ChannelSlashCommandHandlerResult>)
    | undefined;
  defaultText?: string;
}): Promise<ChannelDirectReplyPayload | null> {
  const result = await params.handler?.(params.command, params.msg);
  if (!result?.handled) {
    return null;
  }
  const text = result.text ?? params.defaultText;
  if (!text) {
    return null;
  }
  return {
    text,
    ...(result.modelPicker ? { modelPicker: result.modelPicker } : {}),
  };
}

function normalizeDirectReplyPayload(
  value: string | ChannelDirectReplyPayload | null,
): ChannelDirectReplyPayload | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return { text: value };
  }
  return value;
}

export async function tryHandleChannelSlashCommand(
  adapter: ChannelAdapter,
  msg: InboundChannelMessage,
  options: ChannelSlashCommandOptions = {},
): Promise<boolean> {
  const command =
    parseChannelSlashCommand(msg.text) ??
    (options.enableBangCommands ? parseChannelBangCommand(msg.text) : null);
  if (!command) {
    return false;
  }
  const isBangCommand = command.raw.startsWith("!");
  const isSlackMentionControl = isSlackMentionControlCommand(msg, command);

  if (isBangCommand && !isSupportedSlackMentionCommand(command.name)) {
    await adapter.sendDirectReply(
      msg.chatId,
      buildUnsupportedChannelCommandMessage(msg.channel, command),
      buildDirectReplyOptions(msg),
    );
    return true;
  }

  const canonicalName = canonicalizeChannelCommandName(command.name);
  if (
    options.commandGate &&
    !canRunChannelCommand(options.commandGate, canonicalName)
  ) {
    await adapter.sendDirectReply(
      msg.chatId,
      buildChannelCommandDeniedMessage(
        msg.channel,
        canonicalName,
        options.commandGate,
      ),
      buildDirectReplyOptions(msg),
    );
    return true;
  }

  const reply = normalizeDirectReplyPayload(
    await (async () => {
      switch (command.name) {
        case "help":
          return buildChannelHelpMessage(msg.channel);
        case "whoami":
          return buildChannelWhoamiMessage(msg, options.commandGate);
        case "status":
          return buildChannelStatusMessage(
            msg,
            options.statusContext ?? {
              adapterRunning: adapter.isRunning(),
              accountConfigured: false,
              route: null,
            },
          );
        case "pause":
          return handleScopedCommand({
            msg,
            command,
            handler: options.handlers?.pause,
          });
        case "resume":
          return handleScopedCommand({
            msg,
            command,
            handler: options.handlers?.resume,
          });
        case "cancel":
          return handleScopedCommand({
            msg,
            command,
            handler: options.handlers?.cancel,
            defaultText: buildChannelCancelAcceptedMessage(msg.channel),
          });
        case "chat":
          return handleScopedCommand({
            msg,
            command,
            handler: options.handlers?.chat,
          });
        case "feedback":
          return handleChannelFeedbackCommand({
            msg,
            command,
            route: options.statusContext?.route,
          });
        case "detach":
          if (!isSlackMentionControl) {
            return buildUnsupportedChannelCommandMessage(msg.channel, command);
          }
          return handleScopedCommand({
            msg,
            command,
            handler: options.handlers?.detach,
          });
        case "model":
          return handleScopedCommand({
            msg,
            command,
            handler: options.handlers?.model,
          });
        case "new":
          if (!isSlackMentionControl) {
            return buildUnsupportedChannelCommandMessage(msg.channel, command);
          }
          return handleScopedCommand({
            msg,
            command,
            handler: options.handlers?.newConversation,
          });
        case "reflect":
        case "reflection":
          return handleScopedCommand({
            msg,
            command,
            handler: options.handlers?.reflection,
          });
        case "reload":
          return handleScopedCommand({
            msg,
            command,
            handler: options.handlers?.reload,
          });
        default:
          return buildUnsupportedChannelCommandMessage(msg.channel, command);
      }
    })(),
  );

  if (reply === null) {
    return false;
  }

  await adapter.sendDirectReply(
    msg.chatId,
    reply.text,
    msg.messageId || msg.threadId || reply.modelPicker
      ? {
          replyToMessageId: msg.messageId,
          threadId: msg.threadId ?? null,
          ...(reply.modelPicker ? { modelPicker: reply.modelPicker } : {}),
        }
      : undefined,
  );
  return true;
}
