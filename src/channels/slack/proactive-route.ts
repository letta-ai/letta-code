import type {
  ChannelMessageActionTransport,
  ChannelResolvedMessageTarget,
} from "@/channels/plugin-types";
import {
  addRoute,
  getRouteRaw,
  loadRoutes,
  removeRouteInMemory,
} from "@/channels/routing";
import type { ChannelAdapter } from "@/channels/types";

export interface BindProactiveSlackThreadRouteParams {
  accountId: string;
  chatId: string;
  rootMessageId: string;
  agentId: string;
  conversationId: string;
}

/**
 * Bind replies to a proactively posted Slack root back to the runtime that
 * created it. Existing ownership is idempotent, but a conflicting route is
 * never overwritten.
 */
export function bindProactiveSlackThreadRoute(
  params: BindProactiveSlackThreadRouteParams,
): void {
  loadRoutes("slack");
  const existing = getRouteRaw(
    "slack",
    params.chatId,
    params.accountId,
    params.rootMessageId,
  );
  if (existing) {
    if (
      existing.agentId === params.agentId &&
      existing.conversationId === params.conversationId
    ) {
      return;
    }
    throw new Error(
      `Slack thread ${params.accountId}/${params.chatId}/${params.rootMessageId} is already routed to ${existing.agentId}/${existing.conversationId}`,
    );
  }

  const now = new Date().toISOString();
  try {
    addRoute("slack", {
      accountId: params.accountId,
      chatId: params.chatId,
      chatType: "channel",
      threadId: params.rootMessageId,
      agentId: params.agentId,
      conversationId: params.conversationId,
      enabled: true,
      outboundEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    removeRouteInMemory(
      "slack",
      params.chatId,
      params.accountId,
      params.rootMessageId,
    );
    throw error;
  }
}

interface CreateProactiveSlackTransportParams {
  adapter: ChannelAdapter;
  accountId: string;
  target: ChannelResolvedMessageTarget;
  agentId: string;
  conversationId: string;
}

export function createProactiveSlackTransport(
  params: CreateProactiveSlackTransportParams,
): ChannelMessageActionTransport {
  return {
    sendMessage: async (message) => {
      const result = await params.adapter.sendMessage(message);
      const isRootChannelPost =
        params.target.chatType === "channel" &&
        !message.threadId?.trim() &&
        !message.replyToMessageId?.trim() &&
        !message.reaction;
      if (isRootChannelPost && result.messageId.trim()) {
        try {
          bindProactiveSlackThreadRoute({
            accountId: params.accountId,
            chatId: params.target.chatId,
            rootMessageId: result.messageId,
            agentId: params.agentId,
            conversationId: params.conversationId,
          });
        } catch (error) {
          console.error(
            `[Channels] Failed to bind proactive Slack thread: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          throw new Error(
            `Slack accepted message ${result.messageId}, but its thread route could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return result;
    },
  };
}
