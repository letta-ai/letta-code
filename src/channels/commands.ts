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

export type ChannelStatusContext = {
  adapterRunning: boolean;
  accountConfigured: boolean;
  accountEnabled?: boolean;
  route: ChannelRoute | null;
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

export async function tryHandleChannelSlashCommand(
  adapter: ChannelAdapter,
  msg: InboundChannelMessage,
  options: { statusContext?: ChannelStatusContext } = {},
): Promise<boolean> {
  const command = parseChannelSlashCommand(msg.text);
  if (!command) {
    return false;
  }

  let text: string;
  switch (command.name) {
    case "help":
      text = buildChannelHelpMessage(msg.channel);
      break;
    case "status":
      text = buildChannelStatusMessage(
        msg,
        options.statusContext ?? {
          adapterRunning: adapter.isRunning(),
          accountConfigured: false,
          route: null,
        },
      );
      break;
    default:
      text = buildUnsupportedChannelCommandMessage(msg.channel, command);
      break;
  }

  await adapter.sendDirectReply(
    msg.chatId,
    text,
    msg.messageId ? { replyToMessageId: msg.messageId } : undefined,
  );
  return true;
}
