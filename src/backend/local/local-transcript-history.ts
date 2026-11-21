/**
 * Full-history transcript reads. Streams messages.jsonl and drops image bytes
 * of messages outside the conversation's context as each row is parsed, so a
 * long image-heavy history is not pinned in memory. The file is never written.
 */
import { isRecord } from "@/utils/type-guards";
import {
  forEachJsonlRow,
  isLocalTranscriptAppendEntry,
  LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT,
  type LocalTranscriptMessageFormat,
} from "./local-transcript";

export const LOCAL_OMITTED_IMAGE_PLACEHOLDER =
  "[image omitted: not in context]";

function isImagePart(part: unknown): boolean {
  return isRecord(part) && part.type === "image";
}

function omitImagesOutsideContext(
  message: unknown,
  inContextIds: ReadonlySet<string>,
): unknown {
  if (
    !isRecord(message) ||
    typeof message.id !== "string" ||
    inContextIds.has(message.id) ||
    !Array.isArray(message.content) ||
    !message.content.some(isImagePart)
  ) {
    return message;
  }
  return {
    ...message,
    content: message.content.map((part) =>
      isImagePart(part)
        ? { type: "text", text: LOCAL_OMITTED_IMAGE_PLACEHOLDER }
        : part,
    ),
  };
}

/**
 * Read every transcript row for a full-history load. Image bytes of messages
 * outside `in_context_message_ids` are replaced with a short text placeholder
 * as each row is parsed, so a long image-heavy history does not pin every
 * base64 payload in memory. In memory only: messages.jsonl is never
 * rewritten. An empty id list means every message is in context.
 */
export function readLocalTranscriptRowsForHistory(
  path: string,
  inContextMessageIds: readonly string[],
): unknown[] {
  const inContextIds = new Set(inContextMessageIds);
  const rows: unknown[] = [];
  forEachJsonlRow<unknown>(path, (row) => {
    if (inContextIds.size === 0) {
      rows.push(row);
    } else if (isRecord(row) && isRecord(row.message)) {
      const message = omitImagesOutsideContext(row.message, inContextIds);
      rows.push(message === row.message ? row : { ...row, message });
    } else {
      rows.push(omitImagesOutsideContext(row, inContextIds));
    }
  });
  return rows;
}

/**
 * Count the distinct messages in a transcript that are not in
 * `inContextMessageIds`: the messages compaction has taken out of context.
 * Streams messages.jsonl and keeps only ids. An empty id list means every
 * message is in context.
 */
export function countLocalTranscriptMessagesOutsideContext(
  path: string,
  messageFormat: LocalTranscriptMessageFormat,
  inContextMessageIds: readonly string[],
): number {
  if (inContextMessageIds.length === 0) return 0;
  const inContextIds = new Set(inContextMessageIds);
  const outsideContextIds = new Set<string>();
  forEachJsonlRow<unknown>(path, (row) => {
    const message =
      messageFormat === LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT
        ? row
        : isLocalTranscriptAppendEntry(row)
          ? row.message
          : undefined;
    if (
      isRecord(message) &&
      typeof message.id === "string" &&
      !inContextIds.has(message.id)
    ) {
      outsideContextIds.add(message.id);
    }
  });
  return outsideContextIds.size;
}
