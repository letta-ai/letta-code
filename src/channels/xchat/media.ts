import { extname } from "node:path";
import type { ChannelMessageAttachment } from "@/channels/types";
import type { XChatSdkAttachmentLike } from "./runtime";

function attachmentKind(
  attachment: XChatSdkAttachmentLike,
): ChannelMessageAttachment["kind"] {
  if (
    attachment.type === "image" ||
    attachment.type === "audio" ||
    attachment.type === "video"
  ) {
    return attachment.type;
  }
  return "file";
}

export function describeXChatAttachments(
  messageId: string,
  attachments: XChatSdkAttachmentLike[],
): ChannelMessageAttachment[] {
  return attachments.map((attachment, index) => ({
    id: `${messageId}:${index}`,
    name: attachment.name || `attachment-${index + 1}`,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.size,
    kind: attachmentKind(attachment),
    sourceMessageId: messageId,
  }));
}

export function inferXChatUploadMimeType(fileName: string): string | undefined {
  switch (extname(fileName).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".mp3":
      return "audio/mpeg";
    case ".ogg":
      return "audio/ogg";
    case ".mp4":
      return "video/mp4";
    case ".pdf":
      return "application/pdf";
    default:
      return undefined;
  }
}
