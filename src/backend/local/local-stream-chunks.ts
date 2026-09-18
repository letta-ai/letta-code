import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { LocalMessage } from "./local-message";
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
const LOCAL_SEGMENT_IDENTITY = Symbol.for("@letta/local-segment-identity");

export interface LocalSegmentIdentity {
  contentStartIndex: number;
  useSourceMessageId: boolean;
}

/** Keep the provider segment identity without copying the response-so-far. */
export function attachLocalSegmentIdentity<T extends object>(
  target: T,
  identity: LocalSegmentIdentity,
): T {
  Object.defineProperty(target, LOCAL_SEGMENT_IDENTITY, {
    value: identity,
    enumerable: false,
  });
  return target;
}

function projectedMessageTypeForChunk(
  chunk: LettaStreamingResponse,
): "assistant_message" | "reasoning_message" {
  if (chunk.message_type === "reasoning_message") return "reasoning_message";
  const content = (chunk as unknown as { content?: unknown }).content;
  if (!Array.isArray(content)) return "assistant_message";
  const partTypes = content.flatMap((part) => {
    if (
      typeof part !== "object" ||
      part === null ||
      !("type" in part) ||
      typeof part.type !== "string"
    ) {
      return [];
    }
    return [part.type];
  });
  if (partTypes.includes("text")) return "assistant_message";
  return partTypes.includes("reasoning")
    ? "reasoning_message"
    : "assistant_message";
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

  const identity = (
    chunk as unknown as Record<symbol, LocalSegmentIdentity | undefined>
  )[LOCAL_SEGMENT_IDENTITY];
  const projectedMessageType = projectedMessageTypeForChunk(chunk);
  const id = identity
    ? chunk.message_type === "assistant_message" && identity.useSourceMessageId
      ? message.id
      : `${message.id}:${chunk.message_type === "assistant_message" ? "assistant" : "reasoning"}:${identity.contentStartIndex}`
    : projectLocalMessageToStoredMessages(
        message,
        stored.agent_id,
        stored.conversation_id,
        stored.date,
      )
        .filter((projected) => projected.message_type === projectedMessageType)
        .at(-1)?.id;
  if (!id) return stored;
  // Provider OTIDs are transient and are not persisted. Leaving one here would
  // override the canonical envelope identity in assistant/reasoning consumers.
  const { otid: _otid, ...fields } = stored;
  return { ...fields, id } as StoredMessage;
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
