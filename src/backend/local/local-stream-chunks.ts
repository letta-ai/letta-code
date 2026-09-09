import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { LocalAssistantMessage, LocalMessage } from "./local-message";
import { projectLocalMessageToStoredMessages } from "./local-message-projection";
import type { StoredMessage } from "./local-types";

export type ProviderStreamPart = AssistantMessageEvent;

export function toStoredOutputFields(chunk: Record<string, unknown>) {
  const {
    id: _id,
    date: _date,
    agent_id: _agentId,
    conversation_id: _conversationId,
    ...fields
  } = chunk;
  return fields;
}

const LOCAL_MESSAGE = Symbol.for("@letta/local-provider-message");
const LOCAL_STATE_CHUNK_ONLY = Symbol.for("@letta/local-state-chunk-only");
const LOCAL_CONTENT_PREFIX = Symbol.for("@letta/local-content-prefix");

/** Keep provider block indices intact; delta accumulation alone coalesces blocks. */
export function attachLocalContentPrefix<T extends object>(
  target: T,
  content: LocalAssistantMessage["content"],
  contentIndex: number,
): T {
  Object.defineProperty(target, LOCAL_CONTENT_PREFIX, {
    value: structuredClone(content.slice(0, contentIndex + 1)),
    enumerable: false,
  });
  return target;
}

/** Stream canonical local segment IDs instead of transient provider identities. */
export function canonicalizeLocalStreamChunk(
  chunk: LettaStreamingResponse,
  stored: StoredMessage,
  message: LocalMessage | undefined,
): StoredMessage {
  if (
    message?.role !== "assistant" ||
    (chunk.message_type !== "assistant_message" &&
      chunk.message_type !== "reasoning_message")
  )
    return stored;

  const prefix = (
    chunk as unknown as Record<symbol, LocalAssistantMessage["content"]>
  )[LOCAL_CONTENT_PREFIX];
  if (prefix) message.content = prefix;
  const canonical = projectLocalMessageToStoredMessages(
    message,
    stored.agent_id,
    stored.conversation_id,
    stored.date,
  ).at(-1);
  if (!canonical || canonical.message_type !== chunk.message_type)
    return stored;
  // Provider OTIDs are transient and are not persisted. Leaving one here would
  // override the canonical envelope identity in assistant/reasoning consumers.
  const { otid: _otid, ...fields } = stored;
  return { ...fields, id: canonical.id } as StoredMessage;
}

export function attachLocalMessage<T extends object>(
  target: T,
  message: LocalMessage,
): T {
  Object.defineProperty(target, LOCAL_MESSAGE, {
    value: message,
    enumerable: false,
    configurable: false,
  });
  return target;
}

export function getAttachedLocalMessage(
  value: unknown,
): LocalMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<symbol, LocalMessage | undefined>)[LOCAL_MESSAGE];
}

export function markLocalStateChunkOnly<T extends object>(target: T): T {
  Object.defineProperty(target, LOCAL_STATE_CHUNK_ONLY, {
    value: true,
    enumerable: false,
    configurable: false,
  });
  return target;
}

export function isLocalStateChunkOnly(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, boolean | undefined>)[LOCAL_STATE_CHUNK_ONLY] ===
      true
  );
}
