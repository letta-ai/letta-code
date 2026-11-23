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
