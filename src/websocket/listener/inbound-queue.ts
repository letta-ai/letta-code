import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { QueueItem } from "@/queue/queue-runtime";
import { ordinaryInputIdentity } from "./input-disposition";
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

  // A genuinely new user message releases anything parked by an earlier
  // interrupt. Durable rehydration is observational: it must not alter pause
  // state whether capacity admits or rejects the restored item.
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
      // Forwarded by cloud-api for sender attribution in multi-user sandboxes.
      actingUserId,
    } as Parameters<typeof runtime.queueRuntime.enqueue>[0],
    options,
  );
  if (!enqueuedItem) {
    return false;
  }

  runtime.queuedMessagesByItemId.set(enqueuedItem.id, incoming);
  return true;
}

export function getQueuedInputIdentities(
  runtime: ConversationRuntime,
  items: readonly QueueItem[],
) {
  return items.flatMap((item) => {
    const incoming = runtime.queuedMessagesByItemId.get(item.id);
    const identities = incoming?.durableInputIdentities;
    if (identities?.length) return [...identities];
    // Queue-generated display IDs are not durable acceptance identities.
    const fallback = ordinaryInputIdentity(
      incoming ? getInboundClientMessageId(incoming) : item.clientMessageId,
    );
    return fallback ? [fallback] : [];
  });
}
