import { expect, test } from "bun:test";
import {
  activityBackfillIsUnauthorized,
  fromThreadId,
  isRateLimitError,
  rateLimitDelayMs,
  rawEventIsUnverified,
  readActivityEvent,
  readReplyContext,
  safeErrorMessage,
  toThreadId,
} from "./protocol";

test("normalizes X Chat thread IDs without rewriting arbitrary dashed IDs", () => {
  expect(toThreadId("123:456")).toBe("xchat:123:456");
  expect(toThreadId("xchat:123:456")).toBe("xchat:123:456");
  expect(fromThreadId("xchat:123-456")).toBe("123:456");
  expect(fromThreadId("xchat:dm-conversation")).toBe("dm-conversation");
});

test("normalizes snake-case X activity events for encrypted delivery", () => {
  expect(
    readActivityEvent({
      data: {
        payload: {
          id: "event-1",
          conversation_id: "123-456",
          sender_id: "123",
          encoded_event: "ciphertext",
          sequence_id: 42,
        },
      },
    }),
  ).toEqual({
    conversationId: "123:456",
    incoming: {
      id: "event-1",
      conversationId: "123-456",
      senderId: "123",
      encodedEvent: "ciphertext",
      sequenceId: "42",
    },
  });
});

test("reads validated X Chat reply previews", () => {
  expect(
    readReplyContext({
      decrypted: {
        replyPreviewValidation: "valid",
        content: {
          replyingToPreview: {
            replyingToMessageId: "message-1",
            replyingToMessageSequenceId: "41",
            senderId: "user-1",
            senderDisplayName: "Cameron",
            text: "Original message",
          },
        },
      },
    }),
  ).toEqual({
    messageId: "message-1",
    senderId: "user-1",
    senderName: "Cameron",
    text: "Original message",
  });
});

test("rejects invalid X Chat reply previews", () => {
  expect(
    readReplyContext({
      decrypted: {
        replyPreviewValidation: "invalid",
        content: {
          replyingToPreview: {
            senderId: "user-1",
            text: "forged message",
          },
        },
      },
    }),
  ).toBeUndefined();
});

test("detects explicitly unverified decrypted events", () => {
  expect(rawEventIsUnverified({ decrypted: { verified: false } })).toBe(true);
  expect(rawEventIsUnverified({ decrypted: { verified: true } })).toBe(false);
  expect(rawEventIsUnverified({})).toBe(false);
});

test("uses X rate-limit headers and redacts bot tokens", () => {
  const nowMs = 1_000_000;
  const resetSeconds = nowMs / 1_000 + 30;
  const error = Object.assign(new Error("HTTP 429 for xcbot_secret"), {
    status: 429,
    headers: new Headers({ "x-rate-limit-reset": String(resetSeconds) }),
  });

  expect(isRateLimitError(error)).toBe(true);
  expect(rateLimitDelayMs(error, 1_000, nowMs)).toBe(31_000);
  expect(safeErrorMessage(error)).toBe("HTTP 429 for [redacted]");
});

test("detects activity backfill authorization errors", () => {
  expect(
    activityBackfillIsUnauthorized({
      data: { errors: [{ message: "backfill_minutes is not authorized" }] },
    }),
  ).toBe(true);
});
