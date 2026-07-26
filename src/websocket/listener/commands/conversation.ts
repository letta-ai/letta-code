import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import type {
  ConversationCreateBody,
  ConversationListBody,
  ConversationUpdateBody,
} from "@/backend";
import { getBackend } from "@/backend";
import {
  buildChannelConversationFailedMessage,
  buildChannelConversationForkedMessage,
  buildChannelConversationInvalidMessage,
  buildChannelConversationListMessage,
  buildChannelConversationMenuMessage,
  buildChannelConversationNewMessage,
  buildChannelConversationSwitchedMessage,
  buildChannelConversationWrongAgentMessage,
  type ChannelConversationListEntry,
  parseChannelConversationCommand,
} from "@/channels/conversation-command";
import type { ChannelConversationHandler } from "@/channels/registry-handlers";
import { addRoute } from "@/channels/routing";
import type { ChannelRoute } from "@/channels/types";

function getPageItems<T>(page: unknown): T[] {
  if (Array.isArray(page)) {
    return page as T[];
  }

  if (page && typeof page === "object") {
    const candidate = page as {
      getPaginatedItems?: () => T[];
    };
    if (typeof candidate.getPaginatedItems === "function") {
      return candidate.getPaginatedItems();
    }
  }

  return [];
}

function conversationAgentId(conversation: Conversation): string | null {
  const agentId = (conversation as { agent_id?: unknown }).agent_id;
  return typeof agentId === "string" ? agentId : null;
}

function updateChannelConversationRoute(
  channelId: string,
  route: ChannelRoute,
  conversationId: string,
): ChannelRoute {
  const updatedRoute: ChannelRoute = {
    ...route,
    conversationId,
    enabled: true,
    updatedAt: new Date().toISOString(),
  };
  addRoute(channelId, updatedRoute);
  return updatedRoute;
}

function toConversationListEntries(
  conversations: Conversation[],
): ChannelConversationListEntry[] {
  return conversations.map((conversation) => ({
    id: conversation.id,
    summary:
      typeof conversation.summary === "string" ? conversation.summary : null,
  }));
}

export function createChannelConversationHandler(): ChannelConversationHandler {
  return async ({ channelId, route, args }) => {
    const parsed = parseChannelConversationCommand(args);
    const backend = getBackend();

    try {
      switch (parsed.action) {
        case "menu":
          return {
            handled: true,
            text: buildChannelConversationMenuMessage(channelId, route),
          };
        case "invalid":
          return {
            handled: true,
            text: buildChannelConversationInvalidMessage(
              channelId,
              route,
              parsed.error,
            ),
          };
        case "list": {
          const page = await backend.listConversations({
            agent_id: route.agentId,
            limit: 8,
          } as ConversationListBody);
          return {
            handled: true,
            text: buildChannelConversationListMessage(
              channelId,
              route,
              toConversationListEntries(getPageItems<Conversation>(page)),
            ),
          };
        }
        case "new": {
          const conversation = await backend.createConversation({
            agent_id: route.agentId,
            ...(parsed.title ? { summary: parsed.title } : {}),
          } as ConversationCreateBody);
          updateChannelConversationRoute(channelId, route, conversation.id);
          return {
            handled: true,
            text: buildChannelConversationNewMessage(
              channelId,
              conversation.id,
            ),
          };
        }
        case "switch": {
          if (parsed.conversationId !== "default") {
            const conversation = await backend.retrieveConversation(
              parsed.conversationId,
            );
            if (conversationAgentId(conversation) !== route.agentId) {
              return {
                handled: true,
                text: buildChannelConversationWrongAgentMessage(
                  channelId,
                  parsed.conversationId,
                ),
              };
            }
          }

          updateChannelConversationRoute(
            channelId,
            route,
            parsed.conversationId,
          );
          return {
            handled: true,
            text: buildChannelConversationSwitchedMessage(
              channelId,
              parsed.conversationId,
            ),
          };
        }
        case "fork": {
          const sourceConversationId = route.conversationId;
          const forked = await backend.forkConversation(sourceConversationId, {
            ...(sourceConversationId === "default"
              ? { agentId: route.agentId }
              : {}),
          });
          if (parsed.title) {
            await backend.updateConversation(forked.id, {
              summary: parsed.title,
            } as ConversationUpdateBody);
          }
          updateChannelConversationRoute(channelId, route, forked.id);
          return {
            handled: true,
            text: buildChannelConversationForkedMessage(
              channelId,
              sourceConversationId,
              forked.id,
            ),
          };
        }
      }
    } catch (error) {
      const action =
        parsed.action === "invalid" ? "manage conversations" : parsed.action;
      return {
        handled: true,
        text: buildChannelConversationFailedMessage(
          channelId,
          action,
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
  };
}
