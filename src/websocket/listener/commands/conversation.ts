import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import type {
  ConversationCreateBody,
  ConversationListBody,
  ConversationUpdateBody,
} from "@/backend";
import { getBackend } from "@/backend";
import {
  buildChannelConversationBusyMessage,
  buildChannelConversationFailedMessage,
  buildChannelConversationForkedMessage,
  buildChannelConversationForkedTitleFailedMessage,
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
import { debugWarn } from "@/utils/debug";
import { getConversationRuntime } from "@/websocket/listener/runtime";
import type { ListenerRuntime } from "@/websocket/listener/types";

const CHANNEL_CONVERSATION_LIST_LIMIT = 8;
const CHANNEL_CONVERSATION_FETCH_LIMIT = CHANNEL_CONVERSATION_LIST_LIMIT + 1;

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

function getPageHasMore(items: unknown[]): boolean {
  return items.length > CHANNEL_CONVERSATION_LIST_LIMIT;
}

function failureActionLabel(action: string): string {
  switch (action) {
    case "list":
      return "list conversations";
    case "new":
      return "start a conversation";
    case "switch":
      return "switch conversations";
    case "fork":
      return "fork this conversation";
    default:
      return "manage conversations";
  }
}

function debugLogConversationCommandFailure(params: {
  action: string;
  route: ChannelRoute;
  error: unknown;
}): void {
  debugWarn(
    "channels",
    "Failed to run channel /conv %s for %s/%s: %s",
    params.action,
    params.route.agentId,
    params.route.conversationId,
    params.error instanceof Error
      ? (params.error.stack ?? params.error.message)
      : String(params.error),
  );
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
  const shouldReactivate =
    route.detached === true || route.outboundEnabled === false;
  const updatedRoute: ChannelRoute = {
    ...route,
    conversationId,
    enabled: true,
    updatedAt: new Date().toISOString(),
    ...(shouldReactivate
      ? {
          detached: false,
          outboundEnabled: true,
        }
      : {}),
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

function isConversationMutationAction(
  action: ReturnType<typeof parseChannelConversationCommand>["action"],
): boolean {
  return action === "new" || action === "switch" || action === "fork";
}

function hasActiveOrQueuedWork(
  listener: ListenerRuntime | undefined,
  route: ChannelRoute,
): boolean {
  if (!listener) {
    return false;
  }
  const runtime = getConversationRuntime(
    listener,
    route.agentId,
    route.conversationId,
  );
  if (!runtime) {
    return false;
  }
  return (
    runtime.isProcessing ||
    runtime.pendingTurns > 0 ||
    runtime.queuePumpActive ||
    runtime.queuePumpScheduled ||
    runtime.activeChannelTurn !== null ||
    (runtime.queueRuntime?.length ?? 0) > 0
  );
}

export function createChannelConversationHandler(
  listener?: ListenerRuntime,
): ChannelConversationHandler {
  return async ({ channelId, route, args }) => {
    const parsed = parseChannelConversationCommand(args);
    const backend = getBackend();

    if (
      isConversationMutationAction(parsed.action) &&
      hasActiveOrQueuedWork(listener, route)
    ) {
      return {
        handled: true,
        text: buildChannelConversationBusyMessage(channelId),
      };
    }

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
            limit: CHANNEL_CONVERSATION_FETCH_LIMIT,
            order: "desc",
            order_by: "last_message_at",
            ...(parsed.afterId ? { after: parsed.afterId } : {}),
          } as ConversationListBody);
          const pageItems = getPageItems<Conversation>(page);
          return {
            handled: true,
            text: buildChannelConversationListMessage(
              channelId,
              route,
              toConversationListEntries(
                pageItems.slice(0, CHANNEL_CONVERSATION_LIST_LIMIT),
              ),
              {
                hasMore: getPageHasMore(pageItems),
                limit: CHANNEL_CONVERSATION_LIST_LIMIT,
              },
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
          updateChannelConversationRoute(channelId, route, forked.id);
          if (parsed.title) {
            try {
              await backend.updateConversation(forked.id, {
                summary: parsed.title,
              } as ConversationUpdateBody);
            } catch (error) {
              debugLogConversationCommandFailure({
                action: "fork title update",
                route: { ...route, conversationId: forked.id },
                error,
              });
              return {
                handled: true,
                text: buildChannelConversationForkedTitleFailedMessage(
                  channelId,
                  sourceConversationId,
                  forked.id,
                ),
              };
            }
          }
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
      debugLogConversationCommandFailure({ action, route, error });
      return {
        handled: true,
        text: buildChannelConversationFailedMessage(
          channelId,
          failureActionLabel(action),
        ),
      };
    }
  };
}
