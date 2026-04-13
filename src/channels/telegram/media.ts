import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { getChannelDir } from "../config";
import type { ChannelMessageAttachment } from "../types";

export const TELEGRAM_MEDIA_GROUP_FLUSH_MS = 150;
export const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 15_000;
export const MAX_TELEGRAM_DOWNLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_TELEGRAM_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const ANIMATION_EXTENSIONS = new Set([".gif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a"]);
const VOICE_EXTENSIONS = new Set([".ogg", ".oga", ".opus"]);
const STATIC_STICKER_EXTENSIONS = new Set([".webp"]);

export type TelegramLikeMessage = {
  media_group_id?: string;
  message_id: number | string;
  date: number;
  text?: string;
  caption?: string;
  chat: { id: number | string };
  from?: {
    id: number | string;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  photo?: Array<{
    file_id: string;
    file_unique_id?: string;
    file_size?: number;
  }>;
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  video?: {
    file_id: string;
    file_name?: string;
    file_unique_id?: string;
    mime_type?: string;
    file_size?: number;
  };
  audio?: {
    file_id: string;
    file_name?: string;
    file_unique_id?: string;
    mime_type?: string;
    file_size?: number;
  };
  voice?: {
    file_id: string;
    file_unique_id?: string;
    mime_type?: string;
    file_size?: number;
  };
  animation?: {
    file_id: string;
    file_name?: string;
    file_unique_id?: string;
    mime_type?: string;
    file_size?: number;
  };
  sticker?: {
    file_id: string;
    file_unique_id?: string;
    mime_type?: string;
    file_size?: number;
    is_animated?: boolean;
    is_video?: boolean;
  };
};

export type TelegramAttachmentCandidate = {
  fileId: string;
  kind: ChannelMessageAttachment["kind"];
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
};

export type TelegramUploadMethod =
  | "photo"
  | "document"
  | "video"
  | "audio"
  | "voice"
  | "animation";

type TelegramFileLookup = {
  api: {
    getFile(fileId: string): Promise<{ file_path?: string }>;
  };
};

export function normalizeTelegramMimeType(
  mimeType?: string,
): string | undefined {
  const normalized = mimeType?.split(";")[0]?.trim().toLowerCase();
  return normalized || undefined;
}

export function sanitizeTelegramPathSegment(input: string): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "attachment";
}

function coerceSizeBytes(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function isImageMimeType(mimeType?: string): boolean {
  return normalizeTelegramMimeType(mimeType)?.startsWith("image/") ?? false;
}

function isAudioMimeType(mimeType?: string): boolean {
  return normalizeTelegramMimeType(mimeType)?.startsWith("audio/") ?? false;
}

function isVideoMimeType(mimeType?: string): boolean {
  return normalizeTelegramMimeType(mimeType)?.startsWith("video/") ?? false;
}

function inferAttachmentKind(params: {
  mimeType?: string;
  fileName?: string;
  fallback: ChannelMessageAttachment["kind"];
}): ChannelMessageAttachment["kind"] {
  if (isImageMimeType(params.mimeType)) {
    return "image";
  }
  if (isAudioMimeType(params.mimeType)) {
    return "audio";
  }
  if (isVideoMimeType(params.mimeType)) {
    return "video";
  }

  const lowerName = params.fileName?.toLowerCase();
  if (lowerName) {
    const extension = extname(lowerName);
    if (
      IMAGE_EXTENSIONS.has(extension) ||
      STATIC_STICKER_EXTENSIONS.has(extension)
    ) {
      return "image";
    }
    if (AUDIO_EXTENSIONS.has(extension) || VOICE_EXTENSIONS.has(extension)) {
      return "audio";
    }
    if (
      VIDEO_EXTENSIONS.has(extension) ||
      ANIMATION_EXTENSIONS.has(extension)
    ) {
      return "video";
    }
  }

  return params.fallback;
}

export function extractTelegramMessageText(
  message: TelegramLikeMessage,
): string {
  if (typeof message.text === "string") {
    return message.text;
  }
  if (typeof message.caption === "string") {
    return message.caption;
  }
  return "";
}

export function getTelegramSenderName(
  message: TelegramLikeMessage,
): string | undefined {
  if (!message.from) {
    return undefined;
  }

  return (
    message.from.username ??
    ([message.from.first_name, message.from.last_name]
      .filter(Boolean)
      .join(" ") ||
      undefined)
  );
}

export function collectTelegramAttachmentCandidates(
  message: TelegramLikeMessage,
): TelegramAttachmentCandidate[] {
  const attachments: TelegramAttachmentCandidate[] = [];

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1];
    if (photo?.file_id) {
      attachments.push({
        fileId: photo.file_id,
        kind: "image",
        name: `photo-${photo.file_unique_id ?? photo.file_id}.jpg`,
        mimeType: "image/jpeg",
        sizeBytes: coerceSizeBytes(photo.file_size),
      });
    }
  }

  if (message.document?.file_id) {
    attachments.push({
      fileId: message.document.file_id,
      kind: inferAttachmentKind({
        mimeType: message.document.mime_type,
        fileName: message.document.file_name,
        fallback: "file",
      }),
      name: message.document.file_name,
      mimeType: message.document.mime_type,
      sizeBytes: coerceSizeBytes(message.document.file_size),
    });
  }

  if (message.video?.file_id) {
    attachments.push({
      fileId: message.video.file_id,
      kind: "video",
      name:
        message.video.file_name ??
        `video-${message.video.file_unique_id ?? message.video.file_id}.mp4`,
      mimeType: message.video.mime_type,
      sizeBytes: coerceSizeBytes(message.video.file_size),
    });
  }

  if (message.audio?.file_id) {
    attachments.push({
      fileId: message.audio.file_id,
      kind: "audio",
      name:
        message.audio.file_name ??
        `audio-${message.audio.file_unique_id ?? message.audio.file_id}.mp3`,
      mimeType: message.audio.mime_type,
      sizeBytes: coerceSizeBytes(message.audio.file_size),
    });
  }

  if (message.voice?.file_id) {
    attachments.push({
      fileId: message.voice.file_id,
      kind: "audio",
      name: `voice-${message.voice.file_unique_id ?? message.voice.file_id}.ogg`,
      mimeType: message.voice.mime_type,
      sizeBytes: coerceSizeBytes(message.voice.file_size),
    });
  }

  if (message.animation?.file_id) {
    attachments.push({
      fileId: message.animation.file_id,
      kind: "video",
      name:
        message.animation.file_name ??
        `animation-${message.animation.file_unique_id ?? message.animation.file_id}.gif`,
      mimeType: message.animation.mime_type,
      sizeBytes: coerceSizeBytes(message.animation.file_size),
    });
  }

  if (
    message.sticker?.file_id &&
    !message.sticker.is_animated &&
    !message.sticker.is_video
  ) {
    attachments.push({
      fileId: message.sticker.file_id,
      kind: "image",
      name: `sticker-${message.sticker.file_unique_id ?? message.sticker.file_id}.webp`,
      mimeType: message.sticker.mime_type ?? "image/webp",
      sizeBytes: coerceSizeBytes(message.sticker.file_size),
    });
  }

  return attachments;
}

function inferUploadMethodFromMimeType(
  mimeType?: string,
): TelegramUploadMethod | null {
  const normalized = normalizeTelegramMimeType(mimeType);
  if (!normalized) {
    return null;
  }

  if (["image/png", "image/jpeg"].includes(normalized)) {
    return "photo";
  }
  if (normalized === "image/gif") {
    return "animation";
  }
  if (normalized === "image/webp") {
    return "document";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  if (["audio/ogg", "audio/opus"].includes(normalized)) {
    return "voice";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }

  return null;
}

export function detectTelegramUploadMethod(
  filePath: string,
  fileName?: string,
): TelegramUploadMethod {
  const inferredName = (fileName ?? basename(filePath)).toLowerCase();
  const extension = extname(inferredName);
  const mimeType = inferMimeTypeFromName(inferredName);

  const byMimeType = inferUploadMethodFromMimeType(mimeType);
  if (byMimeType) {
    return byMimeType;
  }

  if (ANIMATION_EXTENSIONS.has(extension)) {
    return "animation";
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }
  if (VOICE_EXTENSIONS.has(extension)) {
    return "voice";
  }
  if (AUDIO_EXTENSIONS.has(extension)) {
    return "audio";
  }

  return "document";
}

export function inferMimeTypeFromName(name: string): string | undefined {
  const normalized = name.toLowerCase();
  const extension = extname(normalized);

  if (IMAGE_EXTENSIONS.has(extension)) {
    return extension === ".png" ? "image/png" : "image/jpeg";
  }
  if (ANIMATION_EXTENSIONS.has(extension)) {
    return "image/gif";
  }
  if (STATIC_STICKER_EXTENSIONS.has(extension)) {
    return "image/webp";
  }
  if (extension === ".mp4" || extension === ".m4v") {
    return "video/mp4";
  }
  if (extension === ".mov") {
    return "video/quicktime";
  }
  if (extension === ".webm") {
    return "video/webm";
  }
  if (extension === ".mp3") {
    return "audio/mpeg";
  }
  if (extension === ".m4a") {
    return "audio/mp4";
  }
  if (VOICE_EXTENSIONS.has(extension)) {
    return "audio/ogg";
  }
  if (extension === ".pdf") {
    return "application/pdf";
  }
  if (extension === ".txt") {
    return "text/plain";
  }
  if (extension === ".md") {
    return "text/markdown";
  }
  if (extension === ".json") {
    return "application/json";
  }

  return undefined;
}

function extensionForMimeType(mimeType?: string): string {
  switch (normalizeTelegramMimeType(mimeType)) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    case "video/webm":
      return ".webm";
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
      return ".m4a";
    case "audio/ogg":
    case "audio/opus":
      return ".ogg";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    case "text/markdown":
      return ".md";
    case "application/json":
      return ".json";
    default:
      return "";
  }
}

function buildTelegramFileUrl(token: string, filePath: string): string {
  return `https://api.telegram.org/file/bot${token}/${filePath}`;
}

function inferAttachmentFileName(params: {
  candidate: TelegramAttachmentCandidate;
  remotePath: string;
  responseMimeType?: string;
}): string {
  const hintedName =
    params.candidate.name?.trim() ||
    basename(params.remotePath) ||
    "attachment";
  if (extname(hintedName)) {
    return hintedName;
  }

  const extension =
    extensionForMimeType(params.responseMimeType) ||
    extensionForMimeType(params.candidate.mimeType);
  return extension ? `${hintedName}${extension}` : hintedName;
}

async function saveTelegramAttachment(params: {
  accountId: string;
  fileName: string;
  buffer: Buffer;
}): Promise<string> {
  const inboundDir = join(
    getChannelDir("telegram"),
    "inbound",
    sanitizeTelegramPathSegment(params.accountId),
  );
  await mkdir(inboundDir, { recursive: true });

  const filePath = join(
    inboundDir,
    `${Date.now()}-${randomUUID()}-${sanitizeTelegramPathSegment(params.fileName)}`,
  );
  await writeFile(filePath, params.buffer);
  return filePath;
}

async function fetchTelegramFile(
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadTelegramAttachment(params: {
  accountId: string;
  token: string;
  bot: TelegramFileLookup;
  candidate: TelegramAttachmentCandidate;
}): Promise<ChannelMessageAttachment | null> {
  const { candidate } = params;

  if (
    typeof candidate.sizeBytes === "number" &&
    candidate.sizeBytes > MAX_TELEGRAM_DOWNLOAD_BYTES
  ) {
    return null;
  }

  const file = await params.bot.api.getFile(candidate.fileId);
  const remotePath = file.file_path;
  if (!remotePath) {
    return null;
  }

  const response = await fetchTelegramFile(
    buildTelegramFileUrl(params.token, remotePath),
    TELEGRAM_DOWNLOAD_TIMEOUT_MS,
  );
  if (!response.ok) {
    return null;
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (
      Number.isFinite(parsedLength) &&
      parsedLength > MAX_TELEGRAM_DOWNLOAD_BYTES
    ) {
      return null;
    }
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_TELEGRAM_DOWNLOAD_BYTES) {
    return null;
  }

  const responseMimeType = normalizeTelegramMimeType(
    response.headers.get("content-type") ?? undefined,
  );
  const fileName = inferAttachmentFileName({
    candidate,
    remotePath,
    responseMimeType,
  });
  const mimeType =
    responseMimeType ??
    normalizeTelegramMimeType(candidate.mimeType) ??
    inferMimeTypeFromName(fileName);
  const kind = inferAttachmentKind({
    mimeType,
    fileName,
    fallback: candidate.kind,
  });
  const localPath = await saveTelegramAttachment({
    accountId: params.accountId,
    fileName,
    buffer,
  });

  return {
    id: candidate.fileId,
    name: fileName,
    mimeType,
    sizeBytes: buffer.byteLength,
    kind,
    localPath,
    ...(kind === "image" && buffer.byteLength <= MAX_TELEGRAM_INLINE_IMAGE_BYTES
      ? { imageDataBase64: buffer.toString("base64") }
      : {}),
  };
}

export async function resolveTelegramInboundAttachments(params: {
  accountId: string;
  token: string;
  bot: TelegramFileLookup;
  messages: TelegramLikeMessage[];
}): Promise<ChannelMessageAttachment[]> {
  const deduped = new Map<string, TelegramAttachmentCandidate>();

  for (const message of params.messages) {
    for (const candidate of collectTelegramAttachmentCandidates(message)) {
      deduped.set(candidate.fileId, candidate);
    }
  }

  if (deduped.size === 0) {
    return [];
  }

  const resolved = await Promise.all(
    Array.from(deduped.values()).map((candidate) =>
      downloadTelegramAttachment({
        accountId: params.accountId,
        token: params.token,
        bot: params.bot,
        candidate,
      }).catch(() => null),
    ),
  );

  return resolved.filter((attachment): attachment is ChannelMessageAttachment =>
    Boolean(attachment),
  );
}
