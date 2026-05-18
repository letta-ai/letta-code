import { getChannelDisplayName } from "./pluginRegistry";
import { addRoute, getRouteRaw, loadRoutes } from "./routing";
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

const CHANNEL_SLASH_COMMANDS: ChannelSlashCommandDefinition[] = [
  {
    name: "help",
    kind: "direct",
    summary: "Show channel usage guidance.",
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

export function buildChannelHelpMessage(channelId: string): string {
  const displayName = channelDisplayName(channelId);
  const supportedCommands = listChannelSlashCommands()
    .filter((definition) => definition.kind === "direct")
    .map((definition) => `/${definition.name}`)
    .join(", ");

  return [
    `${displayName} is connected to Letta Code.`,
    "Send a normal message here and the connected agent will reply in this chat.",
    "Use MessageChannel-supported actions by asking naturally, for example: send a message, react, or upload a file when available.",
    `Supported slash commands here: ${supportedCommands}.`,
    "If this chat is not connected yet, send any non-command message and follow the pairing instructions.",
  ].join("\n\n");
}

export function buildUnsupportedChannelCommandMessage(
  channelId: string,
  command: ParsedChannelSlashCommand,
): string {
  const displayName = channelDisplayName(channelId);
  const supportedCommands = listChannelSlashCommands()
    .filter((definition) => definition.kind === "direct")
    .map((definition) => `/${definition.name}`)
    .join(", ");

  return [
    `${displayName} received ${command.raw}, but that slash command is not supported in channels yet.`,
    `Supported slash commands here: ${supportedCommands}.`,
    "Send normal messages without a leading slash to talk to the connected agent.",
  ].join("\n\n");
}

function findRawRouteForMessage(
  msg: InboundChannelMessage,
): ChannelRoute | null {
  const route =
    getRouteRaw(msg.channel, msg.chatId, msg.accountId, msg.threadId) ??
    (msg.threadId
      ? getRouteRaw(msg.channel, msg.chatId, msg.accountId, null)
      : undefined);
  return route ?? null;
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

function buildNoRouteMessage(channelId: string): string {
  const displayName = channelDisplayName(channelId);
  return [
    `${displayName} could not find an existing route for this chat.`,
    "Send a normal message first and follow the pairing instructions, then try again.",
  ].join("\n\n");
}

function buildPausedMessage(channelId: string, route: ChannelRoute): string {
  const displayName = channelDisplayName(channelId);
  const conversation = route.conversationId
    ? ` Conversation: ${route.conversationId}.`
    : "";
  return `${displayName} paused agent routing for this chat.${conversation} Send /resume here to turn replies back on.`;
}

function buildAlreadyPausedMessage(channelId: string): string {
  return `${channelDisplayName(channelId)} agent routing is already paused for this chat. Send /resume here to turn replies back on.`;
}

function buildResumedMessage(channelId: string, route: ChannelRoute): string {
  const displayName = channelDisplayName(channelId);
  const conversation = route.conversationId
    ? ` Conversation: ${route.conversationId}.`
    : "";
  return `${displayName} resumed agent routing for this chat.${conversation} Normal messages here will go to the connected agent again.`;
}

function buildAlreadyActiveMessage(channelId: string): string {
  return `${channelDisplayName(channelId)} agent routing is already active for this chat.`;
}

export function buildChannelPauseResumeMessage(
  commandName: "pause" | "resume",
  msg: InboundChannelMessage,
): string {
  const route = loadAndFindRawRouteForMessage(msg);
  if (!route) {
    return buildNoRouteMessage(msg.channel);
  }

  if (commandName === "pause") {
    if (route.enabled === false) {
      return buildAlreadyPausedMessage(msg.channel);
    }
    const updatedRoute: ChannelRoute = {
      ...route,
      enabled: false,
      updatedAt: new Date().toISOString(),
    };
    addRoute(msg.channel, updatedRoute);
    return buildPausedMessage(msg.channel, updatedRoute);
  }

  if (route.enabled !== false) {
    return buildAlreadyActiveMessage(msg.channel);
  }
  const updatedRoute: ChannelRoute = {
    ...route,
    enabled: true,
    updatedAt: new Date().toISOString(),
  };
  addRoute(msg.channel, updatedRoute);
  return buildResumedMessage(msg.channel, updatedRoute);
}

export async function tryHandleChannelSlashCommand(
  adapter: ChannelAdapter,
  msg: InboundChannelMessage,
): Promise<boolean> {
  const command = parseChannelSlashCommand(msg.text);
  if (!command) {
    return false;
  }

  const text = (() => {
    switch (command.name) {
      case "help":
        return buildChannelHelpMessage(msg.channel);
      case "pause":
      case "resume":
        return buildChannelPauseResumeMessage(command.name, msg);
      default:
        return buildUnsupportedChannelCommandMessage(msg.channel, command);
    }
  })();

  await adapter.sendDirectReply(
    msg.chatId,
    text,
    msg.messageId ? { replyToMessageId: msg.messageId } : undefined,
  );
  return true;
}
