import { getChannelDisplayName } from "./pluginRegistry";
import type { ChannelAdapter, InboundChannelMessage } from "./types";

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

export async function tryHandleChannelSlashCommand(
  adapter: ChannelAdapter,
  msg: InboundChannelMessage,
): Promise<boolean> {
  const command = parseChannelSlashCommand(msg.text);
  if (!command) {
    return false;
  }

  const text =
    command.name === "help"
      ? buildChannelHelpMessage(msg.channel)
      : buildUnsupportedChannelCommandMessage(msg.channel, command);

  await adapter.sendDirectReply(
    msg.chatId,
    text,
    msg.messageId ? { replyToMessageId: msg.messageId } : undefined,
  );
  return true;
}
