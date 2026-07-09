import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { getChannelDir } from "@/channels/config";
import { transcribeAudioFile } from "@/channels/transcription";
import type {
  ChannelMessageAttachment,
  OutboundChannelMessage,
} from "@/channels/types";
import { sanitizePathSegment } from "./jid";

export const DEFAULT_WHATSAPP_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

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
  account?: { audioAsVoiceMemo?: boolean },
): Record<string, unknown> {
  if (!msg.mediaPath) {
    return { text: msg.text };
  }

  const fileName = msg.fileName || basename(msg.mediaPath);
  const extension = getWhatsAppOutboundMediaExtension(msg);
  const caption = msg.text?.trim() || msg.title?.trim() || undefined;

  const validationError = getWhatsAppOutboundMediaValidationError(msg, account);
  if (validationError) {
    throw new Error(validationError);
  }

  if (WHATSAPP_IMAGE_EXTENSIONS.has(extension)) {
    return { image: { url: msg.mediaPath }, ...(caption ? { caption } : {}) };
  }
  if (WHATSAPP_VIDEO_EXTENSIONS.has(extension)) {
    return { video: { url: msg.mediaPath }, ...(caption ? { caption } : {}) };
  }
  if (
    account?.audioAsVoiceMemo === true &&
    WHATSAPP_VOICE_MEMO_EXTENSIONS.has(extension)
  ) {
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

export const WHATSAPP_VOICE_MEMO_REQUIREMENT =
  "WhatsApp voice memos require an Ogg/Opus file (.ogg, .oga, or .opus). Convert MP3/M4A/WAV audio to Ogg Opus before upload.";

const WHATSAPP_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
]);
const WHATSAPP_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const WHATSAPP_VOICE_MEMO_EXTENSIONS = new Set([".ogg", ".oga", ".opus"]);
const WHATSAPP_AUDIO_EXTENSIONS = new Set([
  ...WHATSAPP_VOICE_MEMO_EXTENSIONS,
  ".mp3",
  ".m4a",
  ".wav",
]);

function getWhatsAppOutboundMediaExtension(
  msg: Pick<OutboundChannelMessage, "mediaPath" | "fileName">,
): string {
  const fileNameExtension = extname(msg.fileName ?? "");
  const mediaPathExtension = extname(msg.mediaPath ?? "");
  return (fileNameExtension || mediaPathExtension).toLowerCase();
}

export function getWhatsAppOutboundMediaValidationError(
  msg: Pick<OutboundChannelMessage, "mediaPath" | "fileName">,
  account?: { audioAsVoiceMemo?: boolean },
): string | null {
  const extension = getWhatsAppOutboundMediaExtension(msg);
  if (
    account?.audioAsVoiceMemo === true &&
    WHATSAPP_AUDIO_EXTENSIONS.has(extension) &&
    !WHATSAPP_VOICE_MEMO_EXTENSIONS.has(extension)
  ) {
    return WHATSAPP_VOICE_MEMO_REQUIREMENT;
  }
  return null;
}
