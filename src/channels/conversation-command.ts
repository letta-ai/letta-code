import { getChannelDisplayName } from "./plugin-registry";
import type { ChannelRoute } from "./types";

export type ParsedChannelConversationCommand =
  | { action: "menu" }
  | { action: "list" }
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
  if (!trimmed || trimmed === "help") {
    return { action: "menu" };
  }

  const [rawAction, ...rest] = trimmed.split(/\s+/);
  const action = rawAction?.toLowerCase();
  const tail = rest.join(" ").trim();

  switch (action) {
    case "list":
      return { action: "list" };
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
    `  ${prefix}/conv list - show recent conversations`,
    `  ${prefix}/conv switch <id> - switch this chat to a conversation`,
    `  ${prefix}/conv fork [title] - fork the current conversation`,
  ].join("\n");
}

export function buildChannelConversationListMessage(
  channelId: string,
  route: ChannelRoute,
  entries: ChannelConversationListEntry[],
): string {
  const displayName = channelDisplayName(channelId);
  const prefix = commandPrefix(channelId);
  if (entries.length === 0) {
    return `${displayName} has no recent conversations for this agent. Use ${prefix}/conv new [title] to start one.`;
  }

  return [
    `${displayName} recent conversations`,
    ...entries.map((entry) => {
      const current = entry.id === route.conversationId ? " (current)" : "";
      return `- ${entry.id}${current} - ${formatTitle(entry.summary)}`;
    }),
    "",
    `Use ${prefix}/conv switch <id> to switch this chat.`,
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
  error: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} could not ${action}: ${error}`;
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
