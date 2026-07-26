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

export function buildChannelConversationMenuMessage(
  channelId: string,
  route: ChannelRoute,
): string {
  const displayName = channelDisplayName(channelId);
  const prefix = commandPrefix(channelId);
  return [
    `${displayName} conversation`,
    `Current: ${route.conversationId}`,
    `Agent: ${route.agentId}`,
    "",
    "Actions:",
    `  ${prefix}/conv new [title] - start a fresh conversation`,
    `  ${prefix}/conv list [after_id] - show recent conversations for the routed agent`,
    `  ${prefix}/conv switch <id> - switch this chat to a conversation`,
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
  return [
    `${displayName} recent conversations for routed agent`,
    `Showing up to ${limit} conversations.`,
    ...entries.map((entry) => {
      const current = entry.id === route.conversationId ? " (current)" : "";
      return `- ${entry.id}${current} - ${formatTitle(entry.summary)}`;
    }),
    "",
    `Use ${prefix}/conv switch <id> to switch this chat.`,
    ...(options.hasMore && lastEntry
      ? [`Use ${prefix}/conv list ${lastEntry.id} to show more.`]
      : []),
  ].join("\n");
}

export function buildChannelConversationNewMessage(
  channelId: string,
  conversationId: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} started a new conversation ${conversationId} for this chat.`;
}

export function buildChannelConversationSwitchedMessage(
  channelId: string,
  conversationId: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} switched this chat to conversation ${conversationId}.`;
}

export function buildChannelConversationForkedMessage(
  channelId: string,
  sourceConversationId: string,
  forkedConversationId: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} forked this chat from ${sourceConversationId} to ${forkedConversationId}.`;
}

export function buildChannelConversationForkedTitleFailedMessage(
  channelId: string,
  sourceConversationId: string,
  forkedConversationId: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} forked this chat from ${sourceConversationId} to ${forkedConversationId}, but could not set the title. This chat is now using the fork.`;
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
  return `${displayName} cannot switch to ${conversationId} because it belongs to a different agent.`;
}

export function buildChannelConversationUnavailableMessage(
  channelId: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} cannot use /conv because the listener is not ready yet. Try again in a moment.`;
}
