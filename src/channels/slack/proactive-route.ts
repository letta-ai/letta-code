import { addRoute, getRouteRaw, loadRoutes } from "@/channels/routing";

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
}
