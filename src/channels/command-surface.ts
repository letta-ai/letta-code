/**
 * Pure channel slash-command surface: the command list, parsing, help text,
 * and unknown-command messaging shared by every channel host.
 *
 * This module must stay free of host-local dependencies (plugin registry,
 * adapters, feedback handlers) so external channel hosts — e.g. Letta Cloud's
 * Slack gateway — can render the exact same command surface as
 * `letta server --channel`. Command execution stays host-injected via
 * `ChannelSlashCommandHandlers`.
 */

import type { ChannelModelPickerData, InboundChannelMessage } from "./types";

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
  modelPicker?: ChannelModelPickerData;
};

export type ChannelSlashCommandHandlers = {
  cancel?: (
    command: ParsedChannelSlashCommand,
    msg: InboundChannelMessage,
  ) => Promise<ChannelSlashCommandHandlerResult>;
  chat?: (
    command: ParsedChannelSlashCommand,
    msg: InboundChannelMessage,
  ) => Promise<ChannelSlashCommandHandlerResult>;
  detach?: (
    command: ParsedChannelSlashCommand,
    msg: InboundChannelMessage,
  ) => Promise<ChannelSlashCommandHandlerResult>;
  model?: (
    command: ParsedChannelSlashCommand,
    msg: InboundChannelMessage,
  ) => Promise<ChannelSlashCommandHandlerResult>;
  newConversation?: (
    command: ParsedChannelSlashCommand,
    msg: InboundChannelMessage,
  ) => Promise<ChannelSlashCommandHandlerResult>;
  pause?: (
    command: ParsedChannelSlashCommand,
    msg: InboundChannelMessage,
  ) => Promise<ChannelSlashCommandHandlerResult>;
  reflection?: (
    command: ParsedChannelSlashCommand,
    msg: InboundChannelMessage,
  ) => Promise<ChannelSlashCommandHandlerResult>;
  reload?: (
    command: ParsedChannelSlashCommand,
    msg: InboundChannelMessage,
  ) => Promise<ChannelSlashCommandHandlerResult>;
  resume?: (
    command: ParsedChannelSlashCommand,
    msg: InboundChannelMessage,
  ) => Promise<ChannelSlashCommandHandlerResult>;
};

/** Resolves a channel id (e.g. "slack") to its human display name. */
export type ChannelDisplayNameResolver = (channelId: string) => string;

const DEFAULT_CHANNEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  custom: "Custom",
  discord: "Discord",
  signal: "Signal",
  slack: "Slack",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
};

/**
 * Default display-name resolver: first-party channel display names, falling
 * back to the raw channel id. Hosts with a richer registry (e.g. user-installed
 * channel plugins) should inject their own resolver.
 */
export function defaultChannelDisplayName(channelId: string): string {
  return DEFAULT_CHANNEL_DISPLAY_NAMES[channelId] ?? channelId;
}

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
    name: "whoami",
    kind: "direct",
    summary: "Show your access tier and runnable commands here.",
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
  {
    name: "chat",
    kind: "direct",
    summary: "Show the Letta web chat link for this channel route.",
  },
  {
    name: "feedback",
    kind: "direct",
    summary: "Send feedback about Letta Code from this routed chat.",
  },
  {
    name: "model",
    kind: "agent-scoped",
    summary:
      "Show, list, or switch the model for this chat's routed conversation.",
  },
  {
    name: "reflection",
    aliases: ["reflect"],
    kind: "agent-scoped",
    summary: "Start a memory reflection pass for this conversation.",
  },
  {
    name: "reload",
    kind: "agent-scoped",
    summary: "Reload settings, local mods, and agent secrets.",
  },
];

const SLACK_MENTION_COMMAND_NAMES = [
  "help",
  "detach",
  "model",
  "new",
  "reload",
] as const;

export function listChannelSlashCommands(): ChannelSlashCommandDefinition[] {
  return CHANNEL_SLASH_COMMANDS.map((definition) => ({
    ...definition,
    aliases: definition.aliases ? [...definition.aliases] : undefined,
  }));
}

type ChannelCommandPrefix = "/" | "!";

function parseSingleLineChannelCommand(
  text: string,
  prefix: ChannelCommandPrefix,
): ParsedChannelSlashCommand | null {
  const trimmed = text.trim();
  const escapedPrefix = prefix === "/" ? "\\/" : "!";
  const match = trimmed.match(
    new RegExp(
      `^${escapedPrefix}([A-Za-z][\\w-]*)(?:@[A-Za-z0-9_]+)?(?:[^\\S\\r\\n]+(.*))?$`,
    ),
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

function parseAnySingleLineChannelCommand(
  text: string,
): ParsedChannelSlashCommand | null {
  return (
    parseSingleLineChannelCommand(text, "/") ??
    parseSingleLineChannelCommand(text, "!")
  );
}

function parseChannelCommand(
  text: string,
  prefix: ChannelCommandPrefix,
): ParsedChannelSlashCommand | null {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const [firstLine, ...remainingLines] = lines;
  if (!firstLine) {
    return null;
  }

  const firstCommand = parseSingleLineChannelCommand(firstLine, prefix);
  if (!firstCommand) {
    return null;
  }

  // Debounced channel input can stack duplicate Slack event copies. If a later
  // line is another channel command, never treat it as the first command's arg.
  const laterCommand = remainingLines.find((line) =>
    Boolean(parseAnySingleLineChannelCommand(line)),
  );
  if (laterCommand) {
    return firstCommand;
  }

  const continuationArgs = remainingLines.join("\n").trim();
  if (!continuationArgs) {
    return firstCommand;
  }
  return {
    ...firstCommand,
    args: [firstCommand.args, continuationArgs]
      .filter((part) => part.length > 0)
      .join("\n"),
  };
}

export function parseChannelSlashCommand(
  text: string,
): ParsedChannelSlashCommand | null {
  return parseChannelCommand(text, "/");
}

export function parseChannelBangCommand(
  text: string,
): ParsedChannelSlashCommand | null {
  return parseChannelCommand(text, "!");
}

function supportedCommandsText(prefix: "/" | "!" = "/"): string {
  return listChannelSlashCommands()
    .map((definition) => `${prefix}${definition.name}`)
    .join(", ");
}

const SLACK_MENTION_SLASH_COMMAND_EXAMPLES = [
  "@agent /help",
  "@agent /status",
  "@agent /whoami",
  "@agent /model",
  "@agent /model list",
  "@agent /model <handle-or-id>",
  "@agent /cancel",
  "@agent /chat",
  "@agent /feedback <message>",
  "@agent /reflection",
  "@agent /detach",
  "@agent /new",
  "@agent /reload",
] as const;

function supportedSlackMentionSlashCommandsText(): string {
  return SLACK_MENTION_SLASH_COMMAND_EXAMPLES.join(", ");
}

function supportedBangCommandsText(): string {
  return SLACK_MENTION_COMMAND_NAMES.map((name) => `!${name}`).join(", ");
}

export function isSupportedSlackMentionCommand(commandName: string): boolean {
  return SLACK_MENTION_COMMAND_NAMES.includes(
    commandName as (typeof SLACK_MENTION_COMMAND_NAMES)[number],
  );
}

export function buildChannelHelpMessage(
  channelId: string,
  resolveDisplayName: ChannelDisplayNameResolver = defaultChannelDisplayName,
): string {
  const displayName = resolveDisplayName(channelId);

  if (channelId === "slack") {
    return [
      `${displayName} is connected to Letta Code.`,
      "Talk by mentioning the app in a channel thread. Once a thread is routed, normal replies continue the same agent conversation until detached.",
      "Control commands start immediately after the mention:",
      "@agent /model - show this thread's current model",
      "@agent /model list - show available models",
      "@agent /model <handle-or-id> - switch this thread's model",
      "@agent /status - show route and listener status",
      "@agent /cancel - cancel the current turn",
      "@agent /chat - show the web chat link",
      "@agent /feedback <message> - send feedback to the Letta team from this routed thread",
      "@agent /reflection - start a memory reflection pass",
      "@agent /detach - stop replying in this thread until mentioned again",
      "@agent /new - start a fresh conversation for this thread",
      "@agent /reload - reload settings, local mods, and agent secrets",
      `Legacy bang aliases still work after a mention: ${supportedBangCommandsText()}.`,
      "If this chat is not connected yet, send a normal message and follow the pairing instructions.",
    ].join("\n");
  }

  return [
    `${displayName} is connected to Letta Code.`,
    "Send a normal message here and the connected agent will reply in this chat.",
    `Supported slash commands here: ${supportedCommandsText()}.`,
    "If this chat is not connected yet, send any non-command message and follow the pairing instructions.",
  ].join("\n\n");
}

export function buildUnsupportedChannelCommandMessage(
  channelId: string,
  command: ParsedChannelSlashCommand,
  resolveDisplayName: ChannelDisplayNameResolver = defaultChannelDisplayName,
): string {
  const displayName = resolveDisplayName(channelId);
  const isBang = command.raw.startsWith("!");
  const commandKind = isBang ? "bang" : "slash";
  const supportedCommands = isBang
    ? supportedBangCommandsText()
    : channelId === "slack"
      ? supportedSlackMentionSlashCommandsText()
      : supportedCommandsText();
  const supportedLabel =
    channelId === "slack" && !isBang
      ? "Slack mention commands"
      : `${commandKind} commands`;

  return [
    `${displayName} received ${command.raw}, but that ${commandKind} command is not supported in channels yet.`,
    `Supported ${supportedLabel}: ${supportedCommands}.`,
    `Send normal messages without a leading ${isBang ? "bang" : "slash"} command to talk to the connected agent.`,
  ].join("\n\n");
}
