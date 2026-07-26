import { formatChannelInlineCode } from "./message-formatting";
import { getChannelDisplayName } from "./plugin-registry";
import type { ChannelRoute } from "./types";

export type ParsedChannelConversationCommand =
  | { action: "menu" }
  | { action: "list"; afterId?: string }
  | { action: "new"; title?: string }
  | { action: "switch"; conversationId: string }
  | { action: "fork"; title?: string }
  | { action: "invalid"; error: string };

export type ChannelConversationListEntry = {
  id: string;
  summary?: string | null;
  current?: boolean;
};

function channelDisplayName(channelId: string): string {
  try {
    return getChannelDisplayName(channelId);
  } catch {
    return channelId;
  }
}

function commandPrefix(channelId: string): string {
  return channelId === "slack" ? "@agent " : "";
}

function formatTitle(title?: string | null): string {
  const trimmed = title?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "Untitled";
}

function formatConversationId(conversationId: string): string {
  return formatChannelInlineCode(conversationId);
}

function formatConversationListEntry(
  route: ChannelRoute,
  entry: ChannelConversationListEntry,
): string {
  const current = entry.current ?? entry.id === route.conversationId;
  const suffix = current ? " (current)" : "";
  return `${formatTitle(entry.summary)}${suffix}: ${formatConversationId(
    entry.id,
  )}`;
}

export function parseChannelConversationCommand(
  args?: string,
): ParsedChannelConversationCommand {
  const trimmed = args?.trim() ?? "";
  if (!trimmed || trimmed.toLowerCase() === "help") {
    return { action: "menu" };
  }

  const [rawAction, ...rest] = trimmed.split(/\s+/);
  const action = rawAction?.toLowerCase();
  const tail = rest.join(" ").trim();

  switch (action) {
    case "list":
      return tail ? { action: "list", afterId: tail } : { action: "list" };
    case "new":
      return tail ? { action: "new", title: tail } : { action: "new" };
    case "switch":
    case "use":
      return tail
        ? { action: "switch", conversationId: tail }
        : { action: "invalid", error: "Usage: /conv switch <conversation_id>" };
    case "fork":
      return tail ? { action: "fork", title: tail } : { action: "fork" };
    default:
      return {
        action: "invalid",
        error: `Unknown /conv action "${rawAction ?? ""}".`,
      };
  }
}

export function requiresPrivilegedChannelConversationAccess(
  args?: string,
): boolean {
  const parsed = parseChannelConversationCommand(args);
  return parsed.action === "list" || parsed.action === "switch";
}

export function buildChannelConversationMenuMessage(
  channelId: string,
  route: ChannelRoute,
): string {
  const displayName = channelDisplayName(channelId);
  const prefix = commandPrefix(channelId);
  return [
    `${displayName} conversation`,
    `Current conversation: ${formatConversationId(route.conversationId)}`,
    `Agent: ${route.agentId}`,
    "",
    "Actions:",
    `  ${prefix}/conv new [title] - start a fresh conversation`,
    `  ${prefix}/conv list [last_conversation_id] - show recent conversations, or older conversations after the last shown id`,
    `  ${prefix}/conv switch <conversation_id> - switch this chat to a conversation`,
    `  ${prefix}/conv fork [title] - fork the current conversation`,
  ].join("\n");
}

export function buildChannelConversationListMessage(
  channelId: string,
  route: ChannelRoute,
  entries: ChannelConversationListEntry[],
  options: { hasMore?: boolean; limit?: number } = {},
): string {
  const displayName = channelDisplayName(channelId);
  const prefix = commandPrefix(channelId);
  const limit = options.limit ?? 8;
  if (entries.length === 0) {
    return `${displayName} has no recent conversations for this agent. Use ${prefix}/conv new [title] to start one.`;
  }

  const lastEntry = entries.at(-1);
  const lines = [
    `${displayName} recent conversations for routed agent`,
    `Showing ${entries.length} recent ${
      entries.length === 1 ? "conversation" : "conversations"
    } newest first. Page size is ${limit}.`,
    "",
  ];
  for (const [index, entry] of entries.entries()) {
    if (index > 0) lines.push("");
    lines.push(formatConversationListEntry(route, entry));
  }
  lines.push(
    `Use ${prefix}/conv switch <conversation_id> to switch this chat.`,
  );
  if (options.hasMore && lastEntry) {
    lines.push(
      `Use ${prefix}/conv list ${formatConversationId(
        lastEntry.id,
      )} to show older conversations.`,
    );
  }
  return lines.join("\n");
}

export function buildChannelConversationNewMessage(
  channelId: string,
  conversationId: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} started a new conversation for this chat: ${formatConversationId(conversationId)}`;
}

export function buildChannelConversationSwitchedMessage(
  channelId: string,
  conversationId: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} switched this chat to conversation: ${formatConversationId(conversationId)}`;
}

export function buildChannelConversationForkedMessage(
  channelId: string,
  sourceConversationId: string,
  forkedConversationId: string,
): string {
  const displayName = channelDisplayName(channelId);
  return [
    `${displayName} forked this chat.`,
    `From: ${formatConversationId(sourceConversationId)}`,
    `To: ${formatConversationId(forkedConversationId)}`,
  ].join("\n");
}

export function buildChannelConversationForkedTitleFailedMessage(
  channelId: string,
  sourceConversationId: string,
  forkedConversationId: string,
): string {
  return [
    buildChannelConversationForkedMessage(
      channelId,
      sourceConversationId,
      forkedConversationId,
    ),
    "",
    "This chat is now using the fork, but the title could not be set.",
  ].join("\n");
}

export function buildChannelConversationInvalidMessage(
  channelId: string,
  route: ChannelRoute,
  error: string,
): string {
  return `${error}\n\n${buildChannelConversationMenuMessage(channelId, route)}`;
}

export function buildChannelConversationFailedMessage(
  channelId: string,
  action: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} could not ${action} right now. Try again in a moment.`;
}

export function buildChannelConversationWrongAgentMessage(
  channelId: string,
  conversationId: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} cannot switch to this conversation because it belongs to a different agent: ${formatConversationId(conversationId)}`;
}

export function buildChannelConversationUnavailableMessage(
  channelId: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} cannot use /conv because the listener is not ready yet. Try again in a moment.`;
}

export function buildChannelConversationBusyMessage(channelId: string): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} cannot change conversations while this chat has an active or queued turn. Wait for it to finish or run /cancel, then try again.`;
}
