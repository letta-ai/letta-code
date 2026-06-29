import type { ListModelsResponseModelEntry } from "@/types/protocol_v2";
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
  chat?: (
    command: ParsedChannelSlashCommand,
    msg: InboundChannelMessage,
  ) => Promise<ChannelSlashCommandHandlerResult>;
  model?: (
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
  {
    name: "chat",
    kind: "direct",
    summary: "Show the Letta web chat link for this channel route.",
  },
  {
    name: "model",
    kind: "agent-scoped",
    summary: "Show or switch the model for this chat's routed conversation.",
  },
  {
    name: "reflection",
    aliases: ["reflect"],
    kind: "agent-scoped",
    summary: "Start a memory reflection pass for this conversation.",
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

type ChannelModelListEntry = Pick<
  ListModelsResponseModelEntry,
  | "id"
  | "handle"
  | "label"
  | "description"
  | "isDefault"
  | "isFeatured"
  | "updateArgs"
>;

const DEFAULT_CHANNEL_MODEL_LIST_LIMIT = 8;

function getModelEntryRank(entry: ChannelModelListEntry): number {
  if (entry.isDefault) return 0;
  if (entry.isFeatured) return 1;
  const effort = (
    entry.updateArgs as { reasoning_effort?: unknown } | undefined
  )?.reasoning_effort;
  if (effort === "medium") return 2;
  if (effort === "high") return 3;
  return 4;
}

function preferModelEntry(
  current: ChannelModelListEntry,
  candidate: ChannelModelListEntry,
): ChannelModelListEntry {
  return getModelEntryRank(candidate) < getModelEntryRank(current)
    ? candidate
    : current;
}

function buildModelEntriesByHandle(
  entries: ChannelModelListEntry[],
): Map<string, ChannelModelListEntry> {
  const byHandle = new Map<string, ChannelModelListEntry>();
  for (const entry of entries) {
    const current = byHandle.get(entry.handle);
    byHandle.set(
      entry.handle,
      current ? preferModelEntry(current, entry) : entry,
    );
  }
  return byHandle;
}

function makeUnknownModelEntry(handle: string): ChannelModelListEntry {
  return {
    id: handle,
    handle,
    label: handle,
    description: "",
  };
}

function resolveModelHandles(params: {
  handles: string[];
  byHandle: Map<string, ChannelModelListEntry>;
  availableHandles?: Set<string> | null;
}): ChannelModelListEntry[] {
  const { handles, byHandle, availableHandles } = params;
  const seen = new Set<string>();
  const resolved: ChannelModelListEntry[] = [];
  for (const handle of handles) {
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    if (availableHandles && !availableHandles.has(handle)) continue;
    resolved.push(byHandle.get(handle) ?? makeUnknownModelEntry(handle));
  }
  return resolved;
}

function getFallbackModelEntries(
  byHandle: Map<string, ChannelModelListEntry>,
): ChannelModelListEntry[] {
  const preferred = Array.from(byHandle.values()).filter(
    (entry) => entry.isDefault || entry.isFeatured,
  );
  return preferred.length > 0 ? preferred : Array.from(byHandle.values());
}

function formatChannelModelEntry(entry: ChannelModelListEntry): string {
  const selector = entry.id || entry.handle;
  const handleText = entry.handle === entry.label ? "" : ` — ${entry.handle}`;
  return `• ${entry.label}${handleText} (/model ${selector})`;
}

function appendModelEntrySection(
  lines: string[],
  title: string,
  entries: ChannelModelListEntry[],
  limit: number,
): void {
  if (entries.length === 0) return;
  lines.push("", `${title}:`);
  for (const entry of entries.slice(0, limit)) {
    lines.push(formatChannelModelEntry(entry));
  }
  const remaining = entries.length - limit;
  if (remaining > 0) {
    lines.push(`…and ${remaining} more.`);
  }
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
  const displayName = channelDisplayName(channelId);
  const limit = params.limit ?? DEFAULT_CHANNEL_MODEL_LIST_LIMIT;
  const entries = params.entries as ChannelModelListEntry[];
  const byHandle = buildModelEntriesByHandle(entries);
  const availableHandleList = Array.isArray(params.availableHandles)
    ? params.availableHandles
    : null;
  const availableSet = availableHandleList
    ? new Set(availableHandleList)
    : null;
  const recentEntries = resolveModelHandles({
    handles: params.recentHandles ?? [],
    byHandle,
    availableHandles: availableSet,
  });
  const availableEntries = availableHandleList
    ? resolveModelHandles({ handles: availableHandleList, byHandle })
    : getFallbackModelEntries(byHandle);

  const lines = [`${displayName} model selector`];
  if (params.availableHandles === null) {
    lines.push(
      "Availability lookup failed; showing built-in recommended models.",
    );
  } else if (params.availableHandles === undefined) {
    lines.push(
      "Available model data was not returned; showing built-in recommended models.",
    );
  }

  appendModelEntrySection(lines, "Recent models", recentEntries, limit);
  appendModelEntrySection(lines, "Available models", availableEntries, limit);

  if (availableEntries.length === 0) {
    lines.push(
      "",
      "No available models were reported. Use /connect in Letta Code to configure a provider, then try again.",
    );
  }

  lines.push(
    "",
    "Use /model <handle-or-id> to switch this chat's routed model.",
  );
  return lines.join("\n");
}

export function buildChannelModelListUnavailableMessage(
  channelId: string,
  error: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} could not load the model list: ${error}`;
}

export function buildChannelModelUpdatedMessage(
  channelId: string,
  params: {
    modelLabel: string;
    modelHandle: string;
    appliedTo?: "agent" | "conversation";
  },
): string {
  const displayName = channelDisplayName(channelId);
  const scope = params.appliedTo === "agent" ? "agent" : "conversation";
  const handleText =
    params.modelHandle === params.modelLabel ? "" : ` (${params.modelHandle})`;
  return `${displayName} updated this ${scope}'s model to ${params.modelLabel}${handleText}.`;
}

export function buildChannelModelUpdateFailedMessage(
  channelId: string,
  identifier: string,
  error: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} could not switch this chat's routed model to ${identifier}: ${error}`;
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
      case "chat":
        return handleScopedCommand({
          msg,
          command,
          handler: options.handlers?.chat,
        });
      case "model":
        return handleScopedCommand({
          msg,
          command,
          handler: options.handlers?.model,
        });
      case "reflect":
      case "reflection":
        return handleScopedCommand({
          msg,
          command,
          handler: options.handlers?.reflection,
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
    msg.messageId || msg.threadId
      ? { replyToMessageId: msg.messageId, threadId: msg.threadId ?? null }
      : undefined,
  );
  return true;
}
