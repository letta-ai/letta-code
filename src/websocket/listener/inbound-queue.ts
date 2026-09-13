import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { QueueItem } from "@/queue/queue-runtime";
import { SYSTEM_REMINDER_RE } from "./constants";
import type { ConversationRuntime, IncomingMessage } from "./types";

/** Display-only copies: the saved batch remains the lossless delivery input. */
export function getVisibleQueuedItems(
  runtime: ConversationRuntime | null | undefined,
): QueueItem[] {
  return (runtime?.queueRuntime.items ?? []).flatMap((item): QueueItem[] => {
    // Notifications and cron prompts have their own display semantics.
    if (item.kind !== "message") return [item];
    const incoming = runtime?.queuedMessagesByItemId.get(item.id);
    const contents = incoming
      ? incoming.messages.flatMap((message) =>
          "content" in message && message.role !== "system"
            ? [message.content]
            : [],
        )
      : [item.content];
    const visible = contents.flatMap((content) => {
      if (typeof content === "string") {
        const text = content.replace(SYSTEM_REMINDER_RE, "").trim();
        return text ? [{ type: "text" as const, text }] : [];
      }
      return content.flatMap((part) => {
        if (part.type !== "text") return [part];
        const text = part.text.replace(SYSTEM_REMINDER_RE, "").trim();
        return text ? [{ ...part, text }] : [];
      });
    });
    if (visible.length === 0) return [];
    const content =
      contents.length === 1 && typeof contents[0] === "string"
        ? visible
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("")
        : visible;
    return [{ ...item, content }];
  });
}

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
): boolean {
  const firstUserPayload = incoming.messages.find(
    (payload): payload is MessageCreate & { client_message_id?: string } =>
      "content" in payload,
  );
  if (!firstUserPayload) {
    return false;
  }

  // A new user message releases anything parked by an earlier interrupt, so
  // the parked messages run first and this one follows in order.
  runtime.queueRuntime.resume();
  const enqueuedItem = runtime.queueRuntime.enqueue({
    kind: "message",
    source: "user",
    content: firstUserPayload.content,
    clientMessageId:
      firstUserPayload.client_message_id ?? `cm-submit-${crypto.randomUUID()}`,
    agentId: incoming.agentId,
    conversationId: incoming.conversationId || "default",
    ...(incoming.noCoalesce ? { noCoalesce: true } : {}),
    // Forwarded by cloud-api for sender attribution in multi-user sandboxes.
    actingUserId,
  } as Parameters<typeof runtime.queueRuntime.enqueue>[0]);
  if (!enqueuedItem) {
    return false;
  }

  runtime.queuedMessagesByItemId.set(enqueuedItem.id, incoming);
  return true;
}
