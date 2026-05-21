import { getChannelDisplayName } from "./plugin-registry";
import type {
  ChannelAdapter,
  ChannelRoute,
  InboundChannelMessage,
} from "./types";

export type ChannelSlashCommandKind = "direct" | "agent-scoped";

export type ParsedChannelSlashCommand = {
  name: string;
  args: string;
  raw: string;
};

export type ChannelSlashCommandDefinition = {
  name: string;
  aliases?: string[];
  kind: ChannelSlashCommandKind;
  summary: string;
};

export type ChannelSlashCommandHandlerResult = {
  handled: boolean;
  text?: string;
};

export type ChannelSlashCommandHandlers = {
  cancel?: (
    command: ParsedChannelSlashCommand,
    msg: InboundChannelMessage,
  ) => Promise<ChannelSlashCommandHandlerResult>;
  pause?: (
    command: ParsedChannelSlashCommand,
    msg: InboundChannelMessage,
  ) => Promise<ChannelSlashCommandHandlerResult>;
  resume?: (
    command: ParsedChannelSlashCommand,
    msg: InboundChannelMessage,
  ) => Promise<ChannelSlashCommandHandlerResult>;
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
};

const CHANNEL_SLASH_COMMANDS: ChannelSlashCommandDefinition[] = [
  {
    name: "help",
    kind: "direct",
    summary: "Show channel usage guidance.",
  },
  {
    name: "status",
    kind: "direct",
    summary: "Show this chat's channel connection status.",
  },
  {
    name: "pause",
    kind: "direct",
    summary: "Pause agent routing for this chat.",
  },
  {
    name: "resume",
    kind: "direct",
    summary: "Resume agent routing for this chat.",
  },
  {
    name: "cancel",
    kind: "agent-scoped",
    summary: "Cancel the in-progress agent turn for this chat.",
  },
];

function channelDisplayName(channelId: string): string {
  try {
    return getChannelDisplayName(channelId);
  } catch {
    return channelId;
  }
}

export function listChannelSlashCommands(): ChannelSlashCommandDefinition[] {
  return CHANNEL_SLASH_COMMANDS.map((definition) => ({
    ...definition,
    aliases: definition.aliases ? [...definition.aliases] : undefined,
  }));
}

export function parseChannelSlashCommand(
  text: string,
): ParsedChannelSlashCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(
    /^\/([A-Za-z][\w-]*)(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/,
  );
  if (!match) {
    return null;
  }
  const [, name, args] = match;
  if (!name) {
    return null;
  }

  return {
    name: name.toLowerCase(),
    args: args?.trim() ?? "",
    raw: trimmed,
  };
}

function supportedCommandsText(): string {
  return listChannelSlashCommands()
    .map((definition) => `/${definition.name}`)
    .join(", ");
}

export function buildChannelHelpMessage(channelId: string): string {
  const displayName = channelDisplayName(channelId);

  return [
    `${displayName} is connected to Letta Code.`,
    "Send a normal message here and the connected agent will reply in this chat.",
    "Use MessageChannel-supported actions by asking naturally, for example: send a message, react, or upload a file when available.",
    `Supported slash commands here: ${supportedCommandsText()}.`,
    "If this chat is not connected yet, send any non-command message and follow the pairing instructions.",
  ].join("\n\n");
}

export function buildUnsupportedChannelCommandMessage(
  channelId: string,
  command: ParsedChannelSlashCommand,
): string {
  const displayName = channelDisplayName(channelId);

  return [
    `${displayName} received ${command.raw}, but that slash command is not supported in channels yet.`,
    `Supported slash commands here: ${supportedCommandsText()}.`,
    "Send normal messages without a leading slash to talk to the connected agent.",
  ].join("\n\n");
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
  const displayName = channelDisplayName(channelId);
  return `${displayName} received /cancel, but there is no in-progress agent turn to cancel for this chat.`;
}

export function buildChannelCancelAcceptedMessage(channelId: string): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} cancelled the in-progress agent turn for this chat.`;
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
}): Promise<string | null> {
  const result = await params.handler?.(params.command, params.msg);
  if (!result?.handled) {
    return null;
  }
  return result.text ?? params.defaultText ?? null;
}

export async function tryHandleChannelSlashCommand(
  adapter: ChannelAdapter,
  msg: InboundChannelMessage,
  options: ChannelSlashCommandOptions = {},
): Promise<boolean> {
  const command = parseChannelSlashCommand(msg.text);
  if (!command) {
    return false;
  }

  const text = await (async () => {
    switch (command.name) {
      case "help":
        return buildChannelHelpMessage(msg.channel);
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
      default:
        return buildUnsupportedChannelCommandMessage(msg.channel, command);
    }
  })();

  if (text === null) {
    return false;
  }

  await adapter.sendDirectReply(
    msg.chatId,
    text,
    msg.messageId ? { replyToMessageId: msg.messageId } : undefined,
  );
  return true;
}
