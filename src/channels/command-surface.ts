/**
 * Pure channel slash-command surface: the command list, parsing, help text,
 * and unknown-command messaging shared by every channel host.
 *
 * This module must stay free of host-local dependencies (plugin registry,
 * adapters, feedback handlers) so external channel hosts — e.g. Letta Cloud's
 * Slack gateway — can render the exact same command surface as
 * `letta server --channel`. Command execution stays host-injected via
 * `ChannelSlashCommandHandlers`.
 *
 * Hosts with commands beyond the shared surface (e.g. Cloud's `/agent`,
 * `/config`, `/convo`) declare them via `ChannelSlashCommandSurfaceOptions`
 * so listing, help, and unknown-command rendering include them first-class.
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

/**
 * Host-extra command surface options. External channel hosts (e.g. Letta
 * Cloud's Slack gateway with `/agent`, `/config`, `/convo`) pass their extra
 * definitions here so listing, help text, and unknown-command rendering
 * include them without any host-side merging.
 *
 * Semantics:
 * - Extras never override the shared surface: an extra whose name collides
 *   (case-insensitively) with a shared command name or alias, a Slack
 *   mention-only command name (`detach`, `new`), or an earlier extra is
 *   dropped, and extra aliases that collide are filtered.
 *   Shared-wins keeps hosts upgrade-safe when the shared surface later
 *   absorbs a command a host had been providing as an extra.
 * - Ordering is stable: shared commands first, in their fixed order, then the
 *   surviving extras in the order the host provided them. Help output renders
 *   extras in a labeled section (`extraCommandsLabel`).
 * - Omitting the options (or passing no extras) keeps every rendered string
 *   byte-identical to the extras-free surface.
 *
 * Parsing needs no extras hook: `parseChannelSlashCommand` /
 * `parseChannelBangCommand` already accept any command-shaped token so hosts
 * can dispatch extras (and render unknown-command replies) from the parsed
 * name.
 */
export type ChannelSlashCommandSurfaceOptions = {
  /** Host-specific command definitions appended after the shared surface. */
  extraCommands?: readonly ChannelSlashCommandDefinition[];
  /**
   * Section label for extras in help output, e.g. "Cloud-only commands".
   * Defaults to "Host commands".
   */
  extraCommandsLabel?: string;
};

const DEFAULT_EXTRA_COMMANDS_LABEL = "Host commands";

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

function copyDefinition(
  definition: ChannelSlashCommandDefinition,
): ChannelSlashCommandDefinition {
  return {
    ...definition,
    aliases: definition.aliases ? [...definition.aliases] : undefined,
  };
}

/**
 * Applies the shared-wins dedupe documented on
 * `ChannelSlashCommandSurfaceOptions`: returns the surviving host extras (as
 * fresh copies) with colliding definitions dropped and colliding aliases
 * filtered.
 */
function dedupedExtraCommands(
  options?: ChannelSlashCommandSurfaceOptions,
): ChannelSlashCommandDefinition[] {
  const extras = options?.extraCommands;
  if (!extras || extras.length === 0) {
    return [];
  }

  // Slack mention-only command names (e.g. "detach", "new") are part of the
  // shared surface even though they are not in the definition list, so they
  // are reserved too.
  const takenNames = new Set<string>(SLACK_MENTION_COMMAND_NAMES);
  for (const definition of CHANNEL_SLASH_COMMANDS) {
    takenNames.add(definition.name.toLowerCase());
    for (const alias of definition.aliases ?? []) {
      takenNames.add(alias.toLowerCase());
    }
  }

  const surviving: ChannelSlashCommandDefinition[] = [];
  for (const extra of extras) {
    const nameKey = extra.name.toLowerCase();
    if (takenNames.has(nameKey)) {
      continue;
    }
    takenNames.add(nameKey);
    const aliases = (extra.aliases ?? []).filter((alias) => {
      const aliasKey = alias.toLowerCase();
      if (takenNames.has(aliasKey)) {
        return false;
      }
      takenNames.add(aliasKey);
      return true;
    });
    surviving.push({
      ...extra,
      aliases: aliases.length > 0 ? aliases : undefined,
    });
  }
  return surviving;
}

export function listChannelSlashCommands(
  options?: ChannelSlashCommandSurfaceOptions,
): ChannelSlashCommandDefinition[] {
  return [
    ...CHANNEL_SLASH_COMMANDS.map(copyDefinition),
    ...dedupedExtraCommands(options),
  ];
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

function supportedCommandsText(
  prefix: "/" | "!" = "/",
  options?: ChannelSlashCommandSurfaceOptions,
): string {
  return listChannelSlashCommands(options)
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

function supportedSlackMentionSlashCommandsText(
  options?: ChannelSlashCommandSurfaceOptions,
): string {
  const extras = dedupedExtraCommands(options).map(
    (definition) => `@agent /${definition.name}`,
  );
  return [...SLACK_MENTION_SLASH_COMMAND_EXAMPLES, ...extras].join(", ");
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
  options?: ChannelSlashCommandSurfaceOptions,
): string {
  const displayName = resolveDisplayName(channelId);
  const extras = dedupedExtraCommands(options);
  const extrasLabel =
    options?.extraCommandsLabel ?? DEFAULT_EXTRA_COMMANDS_LABEL;

  if (channelId === "slack") {
    const extraLines =
      extras.length > 0
        ? [
            `${extrasLabel}:`,
            ...extras.map(
              (definition) =>
                `@agent /${definition.name} - ${definition.summary}`,
            ),
          ]
        : [];
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
      ...extraLines,
      `Legacy bang aliases still work after a mention: ${supportedBangCommandsText()}.`,
      "If this chat is not connected yet, send a normal message and follow the pairing instructions.",
    ].join("\n");
  }

  const extraParagraphs =
    extras.length > 0
      ? [
          `${extrasLabel} here: ${extras
            .map((definition) => `/${definition.name}`)
            .join(", ")}.`,
        ]
      : [];
  return [
    `${displayName} is connected to Letta Code.`,
    "Send a normal message here and the connected agent will reply in this chat.",
    `Supported slash commands here: ${supportedCommandsText()}.`,
    ...extraParagraphs,
    "If this chat is not connected yet, send any non-command message and follow the pairing instructions.",
  ].join("\n\n");
}

export function buildUnsupportedChannelCommandMessage(
  channelId: string,
  command: ParsedChannelSlashCommand,
  resolveDisplayName: ChannelDisplayNameResolver = defaultChannelDisplayName,
  options?: ChannelSlashCommandSurfaceOptions,
): string {
  const displayName = resolveDisplayName(channelId);
  const isBang = command.raw.startsWith("!");
  const commandKind = isBang ? "bang" : "slash";
  // Bang commands are the legacy Slack-mention alias set; host extras are
  // slash-only, so the bang list never includes them.
  const supportedCommands = isBang
    ? supportedBangCommandsText()
    : channelId === "slack"
      ? supportedSlackMentionSlashCommandsText(options)
      : supportedCommandsText("/", options);
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
