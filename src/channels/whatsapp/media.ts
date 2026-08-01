import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { getChannelDir } from "@/channels/config";
import { transcribeAudioFile } from "@/channels/transcription";
import type {
  ChannelMessageAttachment,
  OutboundChannelMessage,
} from "@/channels/types";
import { normalizePhoneLike, sanitizePathSegment } from "./jid";

export const DEFAULT_WHATSAPP_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

// ── Attachment policy ─────────────────────────────────────────────

export const MIME_EXTENSION_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
};

export function inferMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_EXTENSION_MAP[ext] ?? "application/octet-stream";
}

export interface AttachmentPolicyParams {
  attachmentFilter: boolean;
  attachmentMimeTypes: string[];
  attachmentAllowedRecipients: string[];
  attachmentAllowedPaths: string[];
  attachmentPathRecursive: boolean;
}

export function checkAttachmentPolicy(params: {
  policy: AttachmentPolicyParams;
  mediaPath: string;
  recipientChatId: string;
}): string | null {
  const { policy, mediaPath, recipientChatId } = params;

  if (!policy.attachmentFilter) return null;

  // MIME type check
  const mimeType = inferMimeType(mediaPath);
  const allowedMimes = policy.attachmentMimeTypes;
  if (allowedMimes.length === 0) {
    return `Attachment denied: no MIME types are allowed (attachment_mime_types is empty).`;
  }
  if (!allowedMimes.includes("*") && !allowedMimes.includes(mimeType)) {
    return `Attachment denied: MIME type "${mimeType}" is not in the allowed list.`;
  }

  // Recipient check — digit comparison only, no LID resolution
  const allowedRecipients = policy.attachmentAllowedRecipients;
  if (allowedRecipients.length === 0) {
    return `Attachment denied: no recipients are allowed (attachment_allowed_recipients is empty).`;
  }
  if (!allowedRecipients.includes("*")) {
    const normalizedRecipient = normalizePhoneLike(recipientChatId);
    const recipientOk = allowedRecipients.some(
      (entry) => normalizePhoneLike(entry) === normalizedRecipient,
    );
    if (!recipientOk) {
      return `Attachment denied: recipient "${recipientChatId}" is not in the allowed list.`;
    }
  }

  // Path check
  const allowedPaths = policy.attachmentAllowedPaths;
  if (allowedPaths.length === 0) {
    return `Attachment denied: no paths are allowed (attachment_allowed_paths is empty).`;
  }

  let resolvedMediaPath: string;
  try {
    resolvedMediaPath = realpathSync(mediaPath);
  } catch {
    return `Attachment denied: media path "${mediaPath}" does not exist or cannot be resolved.`;
  }

  const mediaStat = statSync(resolvedMediaPath);
  if (!mediaStat.isFile()) {
    return `Attachment denied: media path "${mediaPath}" is not a file.`;
  }

  const mediaDir = dirname(resolvedMediaPath);
  const pathOk = allowedPaths.some((allowedPath) => {
    let resolvedAllowed: string;
    try {
      resolvedAllowed = realpathSync(allowedPath);
    } catch {
      return false;
    }
    const allowedStat = statSync(resolvedAllowed);
    if (!allowedStat.isDirectory()) return false;

    if (resolvedMediaPath === resolvedAllowed) return false;
    if (policy.attachmentPathRecursive) {
      // Recursive: media must be inside the allowed directory tree
      return mediaDir.startsWith(resolvedAllowed + "/");
    }
    // Non-recursive: media must be a direct child of the allowed directory
    return mediaDir === resolvedAllowed;
  });

  if (!pathOk) {
    return `Attachment denied: path "${mediaPath}" is not within an allowed directory.`;
  }

  return null;
}

export type WhatsAppMediaKind =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker";

type MediaCandidate = {
  mediaMessage: Record<string, unknown>;
  mediaKind: WhatsAppMediaKind;
  attachmentKind: ChannelMessageAttachment["kind"];
};

export function unwrapWhatsAppMessageContent(
  message: unknown,
): Record<string, unknown> | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  const ephemeral = record.ephemeralMessage as
    | { message?: unknown }
    | undefined;
  if (ephemeral?.message)
    return unwrapWhatsAppMessageContent(ephemeral.message);
  const viewOnce = record.viewOnceMessage as { message?: unknown } | undefined;
  if (viewOnce?.message) return unwrapWhatsAppMessageContent(viewOnce.message);
  const viewOnceV2 = record.viewOnceMessageV2 as
    | { message?: unknown }
    | undefined;
  if (viewOnceV2?.message)
    return unwrapWhatsAppMessageContent(viewOnceV2.message);
  return record;
}

export function extractWhatsAppText(message: unknown): string {
  const content = unwrapWhatsAppMessageContent(message);
  if (!content) return "";
  const conversation = content.conversation;
  if (typeof conversation === "string") return conversation;
  const extended = content.extendedTextMessage as
    | { text?: unknown }
    | undefined;
  if (typeof extended?.text === "string") return extended.text;
  const image = content.imageMessage as { caption?: unknown } | undefined;
  if (typeof image?.caption === "string") return image.caption;
  const video = content.videoMessage as { caption?: unknown } | undefined;
  if (typeof video?.caption === "string") return video.caption;
  const document = content.documentMessage as { caption?: unknown } | undefined;
  if (typeof document?.caption === "string") return document.caption;
  return "";
}

export function extractMentionedJids(message: unknown): string[] {
  const content = unwrapWhatsAppMessageContent(message);
  if (!content) return [];
  const withContext = [
    content.extendedTextMessage,
    content.imageMessage,
    content.videoMessage,
    content.documentMessage,
    content.audioMessage,
    content.stickerMessage,
  ];
  for (const entry of withContext) {
    const contextInfo = (
      entry as { contextInfo?: { mentionedJid?: unknown } } | undefined
    )?.contextInfo;
    const mentioned = contextInfo?.mentionedJid;
    if (Array.isArray(mentioned)) {
      return mentioned.filter((jid): jid is string => typeof jid === "string");
    }
  }
  return [];
}

export function extractReplyParticipant(message: unknown): string | null {
  const content = unwrapWhatsAppMessageContent(message);
  if (!content) return null;
  const withContext = [
    content.extendedTextMessage,
    content.imageMessage,
    content.videoMessage,
    content.documentMessage,
    content.audioMessage,
    content.stickerMessage,
  ];
  for (const entry of withContext) {
    const participant = (
      entry as { contextInfo?: { participant?: unknown } } | undefined
    )?.contextInfo?.participant;
    if (typeof participant === "string" && participant.trim()) {
      return participant;
    }
  }
  return null;
}

function getMediaCandidate(message: unknown): MediaCandidate | null {
  const content = unwrapWhatsAppMessageContent(message);
  if (!content) return null;
  if (content.imageMessage && typeof content.imageMessage === "object") {
    return {
      mediaMessage: content.imageMessage as Record<string, unknown>,
      mediaKind: "image",
      attachmentKind: "image",
    };
  }
  if (content.videoMessage && typeof content.videoMessage === "object") {
    return {
      mediaMessage: content.videoMessage as Record<string, unknown>,
      mediaKind: "video",
      attachmentKind: "video",
    };
  }
  if (content.audioMessage && typeof content.audioMessage === "object") {
    return {
      mediaMessage: content.audioMessage as Record<string, unknown>,
      mediaKind: "audio",
      attachmentKind: "audio",
    };
  }
  if (content.documentMessage && typeof content.documentMessage === "object") {
    return {
      mediaMessage: content.documentMessage as Record<string, unknown>,
      mediaKind: "document",
      attachmentKind: "file",
    };
  }
  if (content.stickerMessage && typeof content.stickerMessage === "object") {
    return {
      mediaMessage: content.stickerMessage as Record<string, unknown>,
      mediaKind: "sticker",
      attachmentKind: "image",
    };
  }
  return null;
}

function coerceSizeBytes(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object" && "toNumber" in value) {
    const toNumber = (value as { toNumber?: () => number }).toNumber;
    if (typeof toNumber === "function") return toNumber.call(value);
  }
  return undefined;
}

function extensionFromMime(mimeType?: string): string {
  if (!mimeType) return "bin";
  const subtype = mimeType.split(";")[0]?.split("/")[1]?.trim();
  return subtype || "bin";
}

async function streamToBuffer(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Buffer | null> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) {
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function collectWhatsAppAttachments(params: {
  accountId: string;
  chatId: string;
  messageId: string;
  message: unknown;
  downloadContentFromMessage?: (
    message: unknown,
    type: string,
  ) => Promise<AsyncIterable<Uint8Array>>;
  downloadMedia: boolean;
  mediaMaxBytes?: number;
  transcribeVoice: boolean;
}): Promise<{
  attachments: ChannelMessageAttachment[];
  transcriptionText?: string;
}> {
  const candidate = getMediaCandidate(params.message);
  if (!candidate) return { attachments: [] };

  const mimeType =
    typeof candidate.mediaMessage.mimetype === "string"
      ? candidate.mediaMessage.mimetype
      : undefined;
  const sizeBytes = coerceSizeBytes(candidate.mediaMessage.fileLength);
  const rawName =
    typeof candidate.mediaMessage.fileName === "string"
      ? candidate.mediaMessage.fileName
      : undefined;
  const name =
    rawName || `whatsapp-${params.messageId}.${extensionFromMime(mimeType)}`;
  const attachment: ChannelMessageAttachment = {
    id: randomUUID(),
    name,
    mimeType,
    sizeBytes,
    kind: candidate.attachmentKind,
    localPath: "",
  };

  const isVoice =
    candidate.mediaKind === "audio" && candidate.mediaMessage.ptt === true;
  const maxBytes = params.mediaMaxBytes ?? DEFAULT_WHATSAPP_MEDIA_MAX_BYTES;
  const shouldDownload =
    params.downloadMedia &&
    !!params.downloadContentFromMessage &&
    (sizeBytes === undefined || sizeBytes <= maxBytes);

  if (!shouldDownload) {
    return { attachments: [attachment] };
  }
  const downloadContentFromMessage = params.downloadContentFromMessage;
  if (!downloadContentFromMessage) {
    return { attachments: [attachment] };
  }

  const dir = join(
    getChannelDir("whatsapp"),
    "attachments",
    sanitizePathSegment(params.accountId),
    sanitizePathSegment(params.chatId),
  );
  await mkdir(dir, { recursive: true });
  const localPath = join(dir, `${Date.now()}-${sanitizePathSegment(name)}`);
  const stream = await downloadContentFromMessage(
    candidate.mediaMessage,
    candidate.mediaKind,
  );
  const buffer = await streamToBuffer(stream, maxBytes);
  if (!buffer) {
    return { attachments: [attachment] };
  }
  await writeFile(localPath, buffer);
  attachment.localPath = localPath;

  if (isVoice && params.transcribeVoice) {
    const result = await transcribeAudioFile(localPath);
    if (result.success && result.text?.trim()) {
      attachment.transcription = result.text.trim();
      return {
        attachments: [attachment],
        transcriptionText: `[Voice message]: ${attachment.transcription}`,
      };
    }
    if (result.error) {
      attachment.transcription = `Transcription failed: ${result.error}`;
    }
  }

  return { attachments: [attachment] };
}

export function buildWhatsAppOutboundPayload(
  msg: Pick<
    OutboundChannelMessage,
    "text" | "mediaPath" | "fileName" | "title"
  >,
): Record<string, unknown> {
  if (!msg.mediaPath) {
    return { text: msg.text };
  }

  const fileName = msg.fileName || basename(msg.mediaPath);
  const extension = getWhatsAppOutboundMediaExtension(msg);
  const caption = msg.text?.trim() || msg.title?.trim() || undefined;

  const validationError = getWhatsAppOutboundMediaValidationError(msg);
  if (validationError) {
    throw new Error(validationError);
  }

  if (WHATSAPP_IMAGE_EXTENSIONS.has(extension)) {
    return { image: { url: msg.mediaPath }, ...(caption ? { caption } : {}) };
  }
  if (WHATSAPP_VIDEO_EXTENSIONS.has(extension)) {
    return { video: { url: msg.mediaPath }, ...(caption ? { caption } : {}) };
  }
  if (WHATSAPP_VOICE_MEMO_EXTENSIONS.has(extension)) {
    return {
      audio: { url: msg.mediaPath },
      mimetype: "audio/ogg; codecs=opus",
      ptt: true,
    };
  }
  return {
    document: { url: msg.mediaPath },
    fileName,
    mimetype: "application/octet-stream",
    ...(caption ? { caption } : {}),
  };
}

const WHATSAPP_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
]);
const WHATSAPP_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const WHATSAPP_VOICE_MEMO_EXTENSIONS = new Set([".ogg", ".oga", ".opus"]);
// (WHATSAPP_AUDIO_EXTENSIONS removed: the validator no longer gates on the
// non-Opus audio distinction. .mp3/.m4a/.wav are routed to the document
// branch by buildWhatsAppOutboundPayload's catch-all. Kept the comment
// here so future readers know the audio set exists semantically but is
// not enforced.)

function getWhatsAppOutboundMediaExtension(
  msg: Pick<OutboundChannelMessage, "mediaPath" | "fileName">,
): string {
  const fileNameExtension = extname(msg.fileName ?? "");
  const mediaPathExtension = extname(msg.mediaPath ?? "");
  return (fileNameExtension || mediaPathExtension).toLowerCase();
}

export function getWhatsAppOutboundMediaValidationError(
  _msg: Pick<OutboundChannelMessage, "mediaPath" | "fileName">,
): string | null {
  // Non-Opus audio (.mp3/.m4a/.wav) is now sent as a regular audio document
  // attachment via the catch-all branch in buildWhatsAppOutboundPayload, not
  // as a WhatsApp push-to-talk voice memo. The voice-memo path requires the
  // agent to explicitly transcode to Ogg/Opus upstream; the channel itself
  // no longer enforces that gate here. Keeping the parameter for forward
  // compatibility with a future opt-in voice-memo flag.
  return null;
}
