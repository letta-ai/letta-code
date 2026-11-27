import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { markLocalTurnScope } from "./runtime";
import type { ConversationRuntime, IncomingMessage } from "./types";

export function getInboundClientMessageId(
  incoming: IncomingMessage,
): string | undefined {
  return getInboundClientMessageIds(incoming)[0];
}

export function getInboundClientMessageIds(
  incoming: IncomingMessage,
): string[] {
  return incoming.messages.flatMap((payload) => {
    if (!("content" in payload)) return [];
    const clientMessageId = (
      payload as MessageCreate & { client_message_id?: string }
    ).client_message_id;
    return clientMessageId ? [clientMessageId] : [];
  });
}

export function enqueueInboundUserMessage(
  runtime: ConversationRuntime,
  incoming: IncomingMessage,
  actingUserId?: string,
  options: { preserveExisting?: boolean } = {},
): boolean {
  const firstUserPayload = incoming.messages.find(
    (payload): payload is MessageCreate & { client_message_id?: string } =>
      "content" in payload,
  );
  if (!firstUserPayload) {
    return false;
  }

  if (!options.preserveExisting) runtime.queueRuntime.resume();
  const enqueuedItem = runtime.queueRuntime.enqueue(
    {
      kind: "message",
      source: "user",
      content: firstUserPayload.content,
      clientMessageId:
        firstUserPayload.client_message_id ??
        `cm-submit-${crypto.randomUUID()}`,
      agentId: incoming.agentId,
      conversationId: incoming.conversationId || "default",
      ...(incoming.noCoalesce ? { noCoalesce: true } : {}),
      actingUserId,
    } as Parameters<typeof runtime.queueRuntime.enqueue>[0],
    options,
  );
  if (!enqueuedItem) {
    return false;
  }

  markLocalTurnScope(runtime);
  runtime.queuedMessagesByItemId.set(enqueuedItem.id, incoming);
  return true;
}
