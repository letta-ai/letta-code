import { chmod, mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { getChannelDir } from "@/channels/config";
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

function sanitizePathSegment(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized || "attachment";
}

function detectAttachmentMimeType(
  bytes: Buffer,
  kind: ChannelMessageAttachment["kind"],
): string | undefined {
  if (bytes.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg";
  if (bytes.subarray(0, 4).toString("ascii") === "fLaC") return "audio/flac";
  if (bytes.subarray(0, 3).toString("ascii") === "ID3") return "audio/mpeg";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WAVE"
  ) {
    return "audio/wav";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return kind === "audio" ? "audio/webm" : "video/webm";
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    return kind === "audio" ? "audio/mp4" : "video/mp4";
  }
  if (bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  return undefined;
}

function extensionForMimeType(mimeType: string | undefined): string {
  switch (mimeType?.split(";", 1)[0]?.toLowerCase()) {
    case "audio/flac":
      return ".flac";
    case "audio/mp4":
      return ".m4a";
    case "audio/mpeg":
      return ".mp3";
    case "audio/ogg":
      return ".ogg";
    case "audio/wav":
      return ".wav";
    case "audio/webm":
      return ".webm";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "video/mp4":
      return ".mp4";
    case "video/webm":
      return ".webm";
    default:
      return "";
  }
}

function nameWithExtension(name: string, mimeType: string | undefined): string {
  return extname(name) ? name : `${name}${extensionForMimeType(mimeType)}`;
}

async function attachmentBytes(
  attachment: XChatSdkAttachmentLike,
): Promise<Buffer | null> {
  if (!attachment.fetchData) return null;
  const data = await attachment.fetchData();
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Blob) return Buffer.from(await data.arrayBuffer());
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export async function collectXChatAttachments(params: {
  accountId: string;
  chatId: string;
  messageId: string;
  attachments: XChatSdkAttachmentLike[];
  downloadMedia: boolean;
  mediaMaxBytes: number;
  transcribeVoice: boolean;
}): Promise<ChannelMessageAttachment[]> {
  const results: ChannelMessageAttachment[] = [];
  for (const [index, attachment] of params.attachments.entries()) {
    const name = attachment.name || `attachment-${index + 1}`;
    const described: ChannelMessageAttachment = {
      id: `${params.messageId}:${index}`,
      name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.size,
      kind: attachmentKind(attachment),
      sourceMessageId: params.messageId,
    };
    results.push(described);
    if (!params.downloadMedia || !attachment.fetchData) continue;
    if (
      typeof attachment.size !== "number" ||
      attachment.size > params.mediaMaxBytes
    ) {
      if (
        typeof attachment.size === "number" &&
        attachment.size > params.mediaMaxBytes
      ) {
        described.downloadReason = "exceeds_auto_download_limit";
        described.autoDownloadLimitBytes = params.mediaMaxBytes;
      }
      continue;
    }
    try {
      const bytes = await attachmentBytes(attachment);
      if (!bytes) continue;
      if (bytes.byteLength > params.mediaMaxBytes) {
        described.downloadReason = "exceeds_auto_download_limit";
        described.autoDownloadLimitBytes = params.mediaMaxBytes;
        continue;
      }
      described.mimeType =
        described.mimeType ?? detectAttachmentMimeType(bytes, described.kind);
      described.name = nameWithExtension(name, described.mimeType);
      const dir = join(
        getChannelDir("xchat"),
        "attachments",
        sanitizePathSegment(params.accountId),
        sanitizePathSegment(params.chatId),
      );
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") {
        await chmod(dir, 0o700);
      }
      const localPath = join(
        dir,
        `${Date.now()}-${sanitizePathSegment(params.messageId)}-${index}-${sanitizePathSegment(described.name)}`,
      );
      await writeFile(localPath, bytes, { mode: 0o600 });
      described.localPath = localPath;
      described.sizeBytes = bytes.byteLength;
      if (described.kind === "audio" && params.transcribeVoice) {
        const { isTranscriptionConfigured, transcribeAudioFile } = await import(
          "@/channels/transcription"
        );
        if (isTranscriptionConfigured()) {
          const transcription = await transcribeAudioFile(localPath);
          if (transcription.success && transcription.text?.trim()) {
            described.transcription = transcription.text.trim();
          } else if (transcription.error) {
            described.transcriptionError = transcription.error;
          }
        }
      }
    } catch {
      described.downloadReason = "download_failed";
    }
  }
  return results;
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
