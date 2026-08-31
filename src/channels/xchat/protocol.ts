import type { ChannelReplyContext } from "@/channels/types";
import { isRecord } from "@/utils/type-guards";
import type { XChatSdkIncomingEventLike, XChatSdkMessageLike } from "./runtime";

const XCHAT_THREAD_PREFIX = "xchat:";
const MAX_POLL_BACKOFF_MS = 15 * 60_000;

export function toThreadId(chatId: string): string {
  return chatId.startsWith(XCHAT_THREAD_PREFIX)
    ? chatId
    : `${XCHAT_THREAD_PREFIX}${chatId}`;
}

export function fromThreadId(threadId: string): string {
  const conversationId = threadId.startsWith(XCHAT_THREAD_PREFIX)
    ? threadId.slice(XCHAT_THREAD_PREFIX.length)
    : threadId;
  return /^\d+-\d+$/.test(conversationId)
    ? conversationId.replace("-", ":")
    : conversationId;
}

export function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  return error.message.replace(/xcbot_[A-Za-z0-9._-]+/g, "[redacted]");
}

export function activityBackfillIsUnauthorized(error: unknown): boolean {
  if (!isRecord(error) || !isRecord(error.data)) return false;
  const errors = error.data.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some(
    (entry) =>
      isRecord(entry) &&
      typeof entry.message === "string" &&
      entry.message.includes("backfill_minutes"),
  );
}

export function messageTimestamp(message: XChatSdkMessageLike): number {
  const value = message.metadata?.dateSent;
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

export function messageSequenceId(
  message: XChatSdkMessageLike,
): string | undefined {
  if (!isRecord(message.raw)) return undefined;
  const event = message.raw.event;
  const decrypted = message.raw.decrypted;
  for (const source of [event, decrypted]) {
    if (!isRecord(source)) continue;
    const value = source.sequenceId ?? source.sequence_id;
    if (typeof value === "string" && /^\d+$/.test(value)) return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      return String(value);
    }
  }
  return undefined;
}

function stringField(
  value: Record<string, unknown>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const field = value[name];
    if (typeof field === "string" && field.length > 0) return field;
    if (typeof field === "number" && Number.isSafeInteger(field)) {
      return String(field);
    }
  }
  return undefined;
}

export function readReplyContext(
  raw: unknown,
): ChannelReplyContext | undefined {
  if (!isRecord(raw) || !isRecord(raw.decrypted)) return undefined;
  const decrypted = raw.decrypted;
  if (
    decrypted.replyPreviewValidation === "invalid" ||
    decrypted.reply_preview_validation === "invalid" ||
    !isRecord(decrypted.content)
  ) {
    return undefined;
  }
  const previewValue =
    decrypted.content.replyingToPreview ??
    decrypted.content.replying_to_preview;
  if (!isRecord(previewValue)) return undefined;

  const replyContext: ChannelReplyContext = {
    messageId: stringField(
      previewValue,
      "replyingToMessageId",
      "replying_to_message_id",
      "replyingToMessageSequenceId",
      "replying_to_message_sequence_id",
      "messageId",
      "message_id",
    ),
    senderId: stringField(previewValue, "senderId", "sender_id"),
    senderName: stringField(
      previewValue,
      "senderDisplayName",
      "sender_display_name",
    ),
    text: stringField(previewValue, "text", "messageText", "message_text"),
  };
  return Object.values(replyContext).some((value) => value !== undefined)
    ? replyContext
    : undefined;
}

export function rawEventId(raw: unknown): string | undefined {
  if (!isRecord(raw) || !isRecord(raw.event)) return undefined;
  return stringField(raw.event, "id");
}

export function rawEventTimestamp(raw: unknown): number {
  if (isRecord(raw)) {
    for (const source of [raw.decrypted, raw.event]) {
      if (!isRecord(source)) continue;
      const value = source.createdAtMsec ?? source.created_at_msec;
      const timestamp = Number(value);
      if (Number.isFinite(timestamp)) return timestamp;
    }
  }
  return Date.now();
}

export function rawEventIsUnverified(raw: unknown): boolean {
  return (
    isRecord(raw) && isRecord(raw.decrypted) && raw.decrypted.verified === false
  );
}

export function isGroupConversation(conversationId: string): boolean {
  return conversationId.startsWith("g");
}

export function isRateLimitError(error: unknown): boolean {
  if (isRecord(error)) {
    const status = error.status ?? error.statusCode;
    if (status === 429) return true;
  }
  return /\bHTTP(?: status)? 429\b|too many requests/i.test(
    safeErrorMessage(error),
  );
}

function getHeader(error: unknown, name: string): string | null {
  if (!isRecord(error)) return null;
  const headers = error.headers;
  if (headers instanceof Headers) return headers.get(name);
  if (!isRecord(headers)) return null;
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === "string" ? value : null;
}

export function rateLimitDelayMs(
  error: unknown,
  fallbackMs: number,
  nowMs = Date.now(),
): number {
  const retryAfter = getHeader(error, "retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_POLL_BACKOFF_MS, Math.max(1_000, seconds * 1_000));
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(
        MAX_POLL_BACKOFF_MS,
        Math.max(1_000, retryAt - nowMs + 1_000),
      );
    }
  }
  const reset = Number(getHeader(error, "x-rate-limit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.min(
      MAX_POLL_BACKOFF_MS,
      Math.max(1_000, reset * 1_000 - nowMs + 1_000),
    );
  }
  return Math.min(MAX_POLL_BACKOFF_MS, Math.max(1_000, fallbackMs));
}

export function readActivityEvent(event: unknown): {
  incoming: XChatSdkIncomingEventLike | null;
  conversationId: string | null;
} {
  if (!isRecord(event)) {
    return { incoming: null, conversationId: null };
  }
  const envelope = isRecord(event.data) ? event.data : event;
  const payload = isRecord(envelope.payload) ? envelope.payload : envelope;
  const rawConversationId = payload.conversationId ?? payload.conversation_id;
  if (typeof rawConversationId !== "string" || !rawConversationId) {
    return { incoming: null, conversationId: null };
  }
  const conversationId = fromThreadId(rawConversationId);
  const encodedEvent = payload.encodedEvent ?? payload.encoded_event;
  const sequenceId = payload.sequenceId ?? payload.sequence_id;
  const incoming =
    typeof encodedEvent === "string" && encodedEvent
      ? {
          id: String(payload.id ?? ""),
          conversationId: rawConversationId,
          senderId: String(payload.senderId ?? payload.sender_id ?? ""),
          encodedEvent,
          conversationKeyVersion:
            payload.conversationKeyVersion ?? payload.conversation_key_version,
          conversationKeyChangeEvent:
            payload.conversationKeyChangeEvent ??
            payload.conversation_key_change_event,
          conversationToken:
            payload.conversationToken ?? payload.conversation_token,
          encryptedConversationKey:
            payload.encryptedConversationKey ??
            payload.encrypted_conversation_key,
          createdAtMsec: payload.createdAtMsec ?? payload.created_at_msec,
          messageEventSignature:
            payload.messageEventSignature ?? payload.message_event_signature,
          sequenceId:
            typeof sequenceId === "string" || typeof sequenceId === "number"
              ? String(sequenceId)
              : undefined,
        }
      : null;
  return { incoming, conversationId };
}
