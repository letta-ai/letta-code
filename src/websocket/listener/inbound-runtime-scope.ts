import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { RuntimeScope } from "@/types/protocol_v2";
import type { IncomingMessage } from "./types";

export function getParsedRuntimeScope(
  parsed: unknown,
): RuntimeScope<string | null> | null {
  if (!parsed || typeof parsed !== "object" || !("runtime" in parsed))
    return null;
  const runtime = (
    parsed as {
      runtime?: { agent_id?: unknown; conversation_id?: unknown };
    }
  ).runtime;
  if (
    !runtime ||
    (runtime.agent_id !== null && typeof runtime.agent_id !== "string")
  )
    return null;
  return {
    agent_id: runtime.agent_id,
    conversation_id:
      typeof runtime.conversation_id === "string"
        ? runtime.conversation_id
        : "default",
  };
}

export function stampInboundUserMessageOtids(
  incoming: IncomingMessage,
): IncomingMessage {
  let didChange = false;
  const messages = incoming.messages.map((payload) => {
    if (!("content" in payload) || payload.otid) return payload;
    didChange = true;
    return {
      ...payload,
      otid:
        "client_message_id" in payload &&
        typeof payload.client_message_id === "string"
          ? payload.client_message_id
          : crypto.randomUUID(),
    } satisfies MessageCreate & { client_message_id?: string };
  });
  return didChange ? { ...incoming, messages } : incoming;
}
