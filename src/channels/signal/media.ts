import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { getChannelDir } from "@/channels/config";
import type {
  ChannelMessageAttachment,
  InboundChannelMessage,
  SignalChannelAccount,
} from "@/channels/types";
import type {
  SignalAttachmentCandidate,
  SignalDataMessage,
} from "./internal-types";

const DEFAULT_SIGNAL_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const MAX_SIGNAL_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

let signalAttachmentSearchDirsOverride: string[] | null = null;

export function __testOverrideSignalAttachmentSearchDirs(
  dirs: string[] | null,
): void {
  signalAttachmentSearchDirsOverride = dirs;
}

export function buildAttachmentPlaceholder(
  attachments: NonNullable<SignalDataMessage["attachments"]>,
): string {
  if (attachments.length === 0) {
    return "";
  }
  if (attachments.length === 1) {
    const contentType = attachments[0]?.contentType ?? "attachment";
    if (contentType.startsWith("image/")) {
      return "[image attached]";
    }
    if (contentType.startsWith("audio/")) {
      return "[audio attached]";
    }
    if (contentType.startsWith("video/")) {
      return "[video attached]";
    }
    return "[file attached]";
  }
  return `[${attachments.length} files attached]`;
}

export function sanitizeSignalPathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "attachment";
}

export function normalizeSignalMimeType(
  value: string | null | undefined,
): string | undefined {
  const normalized = value?.split(";")[0]?.trim().toLowerCase();
  return normalized || undefined;
}

export function inferSignalMimeTypeFromName(
  fileName: string,
): string | undefined {
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
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".ogg":
    case ".oga":
    case ".opus":
      return "audio/ogg";
    case ".pdf":
      return "application/pdf";
    default:
      return undefined;
  }
}

export function inferSignalAttachmentKind(params: {
  mimeType?: string;
  fileName: string;
}): ChannelMessageAttachment["kind"] {
  if (params.mimeType?.startsWith("image/")) {
    return "image";
  }
  if (params.mimeType?.startsWith("audio/")) {
    return "audio";
  }
  if (params.mimeType?.startsWith("video/")) {
    return "video";
  }
  switch (extname(params.fileName).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
    case ".png":
    case ".gif":
    case ".webp":
      return "image";
    case ".mp3":
    case ".m4a":
    case ".ogg":
    case ".oga":
    case ".opus":
      return "audio";
    case ".mp4":
    case ".mov":
      return "video";
    default:
      return "file";
  }
}

export function resolveSignalAttachmentPath(
  attachment: SignalAttachmentCandidate,
): string | null {
  for (const candidate of [
    attachment.localPath,
    attachment.path,
    attachment.storedFilename,
  ]) {
    const value = candidate?.trim();
    if (!value) {
      continue;
    }
    const resolvedCandidate = isAbsolute(value)
      ? resolveAbsoluteSignalAttachmentPath(value)
      : resolveRelativeSignalAttachmentPath(value);
    if (resolvedCandidate) {
      return resolvedCandidate;
    }
  }

  return null;
}

export function getSignalAttachmentSearchDirs(): string[] {
  if (signalAttachmentSearchDirsOverride) {
    return [...signalAttachmentSearchDirsOverride];
  }

  const dirs: string[] = [];
  const localShare = join(homedir(), ".local", "share");
  try {
    for (const entry of readdirSync(localShare, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("signal-cli")) {
        continue;
      }
      dirs.push(join(localShare, entry.name, "attachments"));
    }
  } catch {
    // Ignore missing ~/.local/share or unreadable entries.
  }

  return dirs;
}

export function isPathInsideDirectory(
  filePath: string,
  directory: string,
): boolean {
  const relativePath = relative(directory, filePath);
  return (
    relativePath === "" ||
    (!!relativePath &&
      !relativePath.startsWith("..") &&
      !isAbsolute(relativePath))
  );
}

export function resolveFileIfPresent(filePath: string): string | null {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return null;
    }
    return realpathSync(filePath);
  } catch {
    return null;
  }
}

export function resolveAbsoluteSignalAttachmentPath(
  value: string,
): string | null {
  const resolvedFile = resolveFileIfPresent(value);
  if (!resolvedFile) {
    return null;
  }

  for (const baseDir of getSignalAttachmentSearchDirs()) {
    let realBaseDir: string;
    try {
      realBaseDir = realpathSync(baseDir);
    } catch {
      continue;
    }
    if (isPathInsideDirectory(resolvedFile, realBaseDir)) {
      return resolvedFile;
    }
  }
  return null;
}

export function isSafeRelativeSignalAttachmentPath(value: string): boolean {
  if (!value || isAbsolute(value)) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment && segment !== "." && segment !== "..");
}

export function resolveRelativeFileUnderDirectory(
  baseDir: string,
  value: string,
): string | null {
  if (!isSafeRelativeSignalAttachmentPath(value)) {
    return null;
  }

  let realBaseDir: string;
  try {
    realBaseDir = realpathSync(baseDir);
  } catch {
    return null;
  }

  const resolvedFile = resolveFileIfPresent(resolve(baseDir, value));
  if (!resolvedFile || !isPathInsideDirectory(resolvedFile, realBaseDir)) {
    return null;
  }
  return resolvedFile;
}

export function resolveRelativeSignalAttachmentPath(
  value: string,
): string | null {
  const normalized = value.replace(/\\/g, "/");
  const suffix = normalized.startsWith("attachments/")
    ? normalized.slice("attachments/".length)
    : normalized;
  const candidates = Array.from(new Set([normalized, suffix]));

  for (const baseDir of getSignalAttachmentSearchDirs()) {
    for (const candidate of candidates) {
      const resolvedCandidate = resolveRelativeFileUnderDirectory(
        baseDir,
        candidate,
      );
      if (resolvedCandidate) {
        return resolvedCandidate;
      }
    }
  }

  return null;
}

export function signalMimeTypeMatchesFileName(
  mimeType: string | undefined,
  filePath: string,
): boolean {
  if (!mimeType) {
    return true;
  }
  const extension = extname(filePath).toLowerCase();
  if (mimeType.startsWith("image/")) {
    return [".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(extension);
  }
  if (mimeType.startsWith("audio/")) {
    return (
      extension === "" ||
      [".aac", ".m4a", ".mp3", ".ogg", ".oga", ".opus", ".wav"].includes(
        extension,
      )
    );
  }
  if (mimeType.startsWith("video/")) {
    return extension === "" || [".mp4", ".mov", ".webm"].includes(extension);
  }
  return true;
}

export function resolveRecentSignalAttachmentPath(params: {
  attachment: SignalAttachmentCandidate;
  receivedAt: number;
  seenPaths: Set<string>;
}): string | null {
  const mimeType = normalizeSignalMimeType(params.attachment.contentType);
  const expectedSize =
    typeof params.attachment.size === "number" && params.attachment.size >= 0
      ? params.attachment.size
      : undefined;
  const targetTime = Number.isFinite(params.receivedAt)
    ? params.receivedAt
    : Date.now();
  const maxDeltaMs = 10 * 60 * 1000;
  let best: { path: string; delta: number; mtimeMs: number } | null = null;

  for (const baseDir of getSignalAttachmentSearchDirs()) {
    let entries: Dirent[];
    try {
      entries = readdirSync(baseDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const candidatePath = join(baseDir, entry.name);
      if (params.seenPaths.has(candidatePath)) {
        continue;
      }
      if (!signalMimeTypeMatchesFileName(mimeType, candidatePath)) {
        continue;
      }
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(candidatePath);
      } catch {
        continue;
      }
      if (expectedSize !== undefined && stat.size !== expectedSize) {
        continue;
      }
      const delta = Math.abs(stat.mtimeMs - targetTime);
      if (delta > maxDeltaMs) {
        continue;
      }
      if (
        !best ||
        delta < best.delta ||
        (delta === best.delta && stat.mtimeMs > best.mtimeMs)
      ) {
        best = { path: candidatePath, delta, mtimeMs: stat.mtimeMs };
      }
    }
  }

  return best?.path ?? null;
}

export function resolveSignalAttachmentFileName(
  attachment: SignalAttachmentCandidate,
  sourcePath: string,
): string {
  const hintedName = attachment.filename?.trim();
  if (hintedName && !hintedName.includes("/") && !hintedName.includes("\\")) {
    return hintedName;
  }
  return basename(sourcePath) || "attachment";
}

export function copySignalAttachment(params: {
  accountId: string;
  attachment: SignalAttachmentCandidate;
  sourcePath: string;
  maxBytes: number;
}): ChannelMessageAttachment | null {
  const sourceStat = statSync(params.sourcePath);
  const sizeBytes =
    typeof params.attachment.size === "number" && params.attachment.size >= 0
      ? params.attachment.size
      : sourceStat.size;
  if (sizeBytes > params.maxBytes || sourceStat.size > params.maxBytes) {
    console.warn(
      `[Signal] Skipping attachment ${params.attachment.filename ?? params.attachment.id ?? basename(params.sourcePath)}: ${Math.max(sizeBytes, sourceStat.size)} bytes exceeds Signal download limit (${params.maxBytes} bytes).`,
    );
    return null;
  }

  const fileName = resolveSignalAttachmentFileName(
    params.attachment,
    params.sourcePath,
  );
  const mimeType =
    normalizeSignalMimeType(params.attachment.contentType) ??
    inferSignalMimeTypeFromName(fileName);
  const kind = inferSignalAttachmentKind({ mimeType, fileName });
  const inboundDir = join(
    getChannelDir("signal"),
    "inbound",
    sanitizeSignalPathSegment(params.accountId),
  );
  mkdirSync(inboundDir, { recursive: true });

  const localPath = join(
    inboundDir,
    `${Date.now()}-${randomUUID()}-${sanitizeSignalPathSegment(fileName)}`,
  );
  copyFileSync(params.sourcePath, localPath);

  const attachment: ChannelMessageAttachment = {
    id: params.attachment.id ?? undefined,
    name: fileName,
    mimeType,
    sizeBytes,
    kind,
    localPath,
  };

  if (kind === "image" && sizeBytes <= MAX_SIGNAL_INLINE_IMAGE_BYTES) {
    attachment.imageDataBase64 = readFileSync(localPath).toString("base64");
  }

  return attachment;
}

export function resolveSignalInboundAttachments(
  account: SignalChannelAccount,
  attachments: NonNullable<SignalDataMessage["attachments"]>,
  receivedAt: number,
): ChannelMessageAttachment[] {
  if (account.downloadMedia !== true || attachments.length === 0) {
    return [];
  }

  const maxBytes = account.mediaMaxBytes ?? DEFAULT_SIGNAL_MEDIA_MAX_BYTES;
  const resolved: ChannelMessageAttachment[] = [];
  const seenPaths = new Set<string>();

  for (const attachment of attachments) {
    const sourcePath =
      resolveSignalAttachmentPath(attachment) ??
      resolveRecentSignalAttachmentPath({
        attachment,
        receivedAt,
        seenPaths,
      });
    if (!sourcePath || seenPaths.has(sourcePath)) {
      if (!sourcePath) {
        console.warn(
          `[Signal] Could not resolve attachment ${attachment.filename ?? attachment.id ?? attachment.contentType ?? "unknown"} to a local file.`,
        );
      }
      continue;
    }
    seenPaths.add(sourcePath);
    try {
      const copied = copySignalAttachment({
        accountId: account.accountId,
        attachment,
        sourcePath,
        maxBytes,
      });
      if (copied) {
        resolved.push(copied);
      }
    } catch (error) {
      console.warn(
        `[Signal] Attachment copy failed for ${attachment.filename ?? attachment.id ?? sourcePath}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return resolved;
}

export async function transcribeSignalInboundAttachments(
  account: SignalChannelAccount,
  msg: InboundChannelMessage,
): Promise<InboundChannelMessage> {
  if (account.transcribeVoice !== true || !msg.attachments?.length) {
    return msg;
  }

  let changed = false;
  const attachments = await Promise.all(
    msg.attachments.map(async (attachment) => {
      if (attachment.kind !== "audio" || attachment.transcription) {
        return attachment;
      }
      if (!attachment.localPath) {
        return attachment;
      }

      const next = { ...attachment };
      const { isTranscriptionConfigured, transcribeAudioFile } = await import(
        "@/channels/transcription/index"
      );
      if (!isTranscriptionConfigured()) {
        next.transcriptionError =
          "OPENAI_API_KEY not set; transcription skipped.";
        changed = true;
        return next;
      }

      const result = await transcribeAudioFile(attachment.localPath);
      if (result.success && result.text) {
        next.transcription = result.text;
        changed = true;
      } else if (result.error) {
        next.transcriptionError = result.error;
        changed = true;
        console.warn(
          `[Signal] Voice transcription failed for ${attachment.name ?? attachment.localPath}:`,
          result.error,
        );
      }
      return next;
    }),
  );

  return changed ? { ...msg, attachments } : msg;
}
