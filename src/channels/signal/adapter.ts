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
  ChannelAdapter,
  ChannelAdapterStartOptions,
  ChannelMessageAttachment,
  ChannelTurnLifecycleEvent,
  ChannelTurnSource,
  InboundChannelMessage,
  OutboundChannelMessage,
  SignalChannelAccount,
} from "@/channels/types";
import type { SignalReactionParams, SignalSseEvent } from "./client";
import { SignalRestClient } from "./client";
import type { SignalMessageTarget } from "./target";
import {
  isSignalGroupAllowed,
  matchesSignalMentionPatterns,
  parseSignalTarget,
} from "./target";

export type SignalClientLike = Pick<
  SignalRestClient,
  "check" | "sendMessage" | "sendReaction" | "sendTyping" | "streamEvents"
>;

export type SignalAdapterOptions = {
  client?: SignalClientLike;
  retryMs?: number;
};

type SignalDataMessage = {
  timestamp?: number | null;
  message?: string | null;
  attachments?: Array<{
    id?: string | null;
    contentType?: string | null;
    filename?: string | null;
    storedFilename?: string | null;
    path?: string | null;
    localPath?: string | null;
    size?: number | null;
  }> | null;
  mentions?: Array<{
    name?: string | null;
    number?: string | null;
    uuid?: string | null;
  }> | null;
  groupInfo?: {
    groupId?: string | null;
    groupName?: string | null;
  } | null;
  quote?: {
    text?: string | null;
    author?: string | null;
    authorUuid?: string | null;
  } | null;
  reaction?: SignalReactionMessage | null;
};

type SignalReactionMessage = {
  emoji?: string | null;
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
  targetSentTimestamp?: number | null;
  isRemove?: boolean | null;
  groupInfo?: {
    groupId?: string | null;
    groupName?: string | null;
  } | null;
};

type SignalEnvelope = {
  sourceNumber?: string | null;
  sourceUuid?: string | null;
  sourceName?: string | null;
  timestamp?: number | null;
  dataMessage?: SignalDataMessage | null;
  editMessage?: { dataMessage?: SignalDataMessage | null } | null;
  reactionMessage?: SignalReactionMessage | null;
  syncMessage?: SignalSyncMessage | null;
};

type SignalSentSyncMessage = SignalDataMessage & {
  destination?: string | null;
  destinationNumber?: string | null;
  destinationUuid?: string | null;
  recipients?: string[] | null;
  timestamp?: number | null;
};

type SignalSyncMessage = {
  sentMessage?: SignalSentSyncMessage | null;
};

type SignalReceivePayload = {
  account?: string | null;
  envelope?: SignalEnvelope | null;
  exception?: { message?: string | null } | null;
};

type SignalAttachmentCandidate = NonNullable<
  SignalDataMessage["attachments"]
>[number];

type SignalTypingEntry = {
  source: ChannelTurnSource;
  timer: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout>;
};

const DEFAULT_SIGNAL_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const MAX_SIGNAL_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const SIGNAL_TYPING_REFRESH_MS = 10_000;
const SIGNAL_TYPING_TIMEOUT_MS = 5 * 60 * 1000;
let signalAttachmentSearchDirsOverride: string[] | null = null;

export function __testOverrideSignalAttachmentSearchDirs(
  dirs: string[] | null,
): void {
  signalAttachmentSearchDirsOverride = dirs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSignalEventData(
  event: SignalSseEvent,
): SignalReceivePayload | null {
  if (event.event && event.event !== "receive") {
    return null;
  }
  if (!event.data) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    return parsed as SignalReceivePayload;
  } catch {
    return null;
  }
}

function normalizeIdentity(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function isOwnSignalMessage(
  envelope: SignalEnvelope,
  account: SignalChannelAccount,
): boolean {
  const accountPhone = normalizeIdentity(account.account);
  const accountUuid = normalizeIdentity(account.accountUuid);
  const senderPhone = normalizeIdentity(envelope.sourceNumber);
  const senderUuid = normalizeIdentity(envelope.sourceUuid);
  return (
    (!!accountPhone && !!senderPhone && accountPhone === senderPhone) ||
    (!!accountUuid && !!senderUuid && accountUuid === senderUuid)
  );
}

function signalIdentityMatchesAccount(
  identity: string | null | undefined,
  account: SignalChannelAccount,
): boolean {
  const normalized = normalizeIdentity(identity);
  if (!normalized) return false;
  return (
    normalized === normalizeIdentity(account.account) ||
    normalized === normalizeIdentity(account.accountUuid)
  );
}

function normalizeSignalAliasKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function formatSignalAdapterError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function resolveSignalRecipientAlias(
  identity: string | null | undefined,
  account: SignalChannelAccount,
): string | null {
  const key = normalizeSignalAliasKey(identity);
  if (!key) return null;
  const aliases = account.recipientAliases ?? {};
  for (const [from, to] of Object.entries(aliases)) {
    if (normalizeSignalAliasKey(from) === key && to.trim()) {
      return to.trim();
    }
  }
  return null;
}

function syncMessageTargetsOwnAccount(
  sentMessage: SignalSentSyncMessage,
  account: SignalChannelAccount,
): boolean {
  if (signalIdentityMatchesAccount(sentMessage.destination, account)) {
    return true;
  }
  if (signalIdentityMatchesAccount(sentMessage.destinationNumber, account)) {
    return true;
  }
  if (signalIdentityMatchesAccount(sentMessage.destinationUuid, account)) {
    return true;
  }
  return (sentMessage.recipients ?? []).some((recipient) =>
    signalIdentityMatchesAccount(recipient, account),
  );
}

function envelopeFromSelfSyncMessage(
  envelope: SignalEnvelope,
  account: SignalChannelAccount,
): SignalEnvelope | null {
  const sentMessage = envelope.syncMessage?.sentMessage;
  if (!sentMessage || !syncMessageTargetsOwnAccount(sentMessage, account)) {
    return null;
  }
  return {
    sourceNumber: account.account ?? envelope.sourceNumber,
    sourceUuid: account.accountUuid ?? envelope.sourceUuid,
    sourceName: "Note to Self",
    timestamp: sentMessage.timestamp ?? envelope.timestamp,
    dataMessage: sentMessage,
  };
}

function signalTargetMatchesAccount(
  target: SignalMessageTarget,
  account: SignalChannelAccount,
): boolean {
  return (
    target.kind === "recipient" &&
    signalIdentityMatchesAccount(target.recipient, account)
  );
}

function renderSignalMentions(
  text: string,
  mentions: SignalDataMessage["mentions"],
): string {
  let mentionIndex = 0;
  return text.replace(/\uFFFC/g, () => {
    const mention = mentions?.[mentionIndex++];
    const label = mention?.name ?? mention?.number ?? mention?.uuid;
    return label ? `@${label}` : "@mention";
  });
}

function buildAttachmentPlaceholder(
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

function sanitizeSignalPathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "attachment";
}

function normalizeSignalMimeType(
  value: string | null | undefined,
): string | undefined {
  const normalized = value?.split(";")[0]?.trim().toLowerCase();
  return normalized || undefined;
}

function inferSignalMimeTypeFromName(fileName: string): string | undefined {
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

function inferSignalAttachmentKind(params: {
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

function resolveSignalAttachmentPath(
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

function getSignalAttachmentSearchDirs(): string[] {
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

function isPathInsideDirectory(filePath: string, directory: string): boolean {
  const relativePath = relative(directory, filePath);
  return (
    relativePath === "" ||
    (!!relativePath &&
      !relativePath.startsWith("..") &&
      !isAbsolute(relativePath))
  );
}

function resolveFileIfPresent(filePath: string): string | null {
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

function resolveAbsoluteSignalAttachmentPath(value: string): string | null {
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

function isSafeRelativeSignalAttachmentPath(value: string): boolean {
  if (!value || isAbsolute(value)) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment && segment !== "." && segment !== "..");
}

function resolveRelativeFileUnderDirectory(
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

function resolveRelativeSignalAttachmentPath(value: string): string | null {
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

function signalMimeTypeMatchesFileName(
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

function resolveRecentSignalAttachmentPath(params: {
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

function resolveSignalAttachmentFileName(
  attachment: SignalAttachmentCandidate,
  sourcePath: string,
): string {
  const hintedName = attachment.filename?.trim();
  if (hintedName && !hintedName.includes("/") && !hintedName.includes("\\")) {
    return hintedName;
  }
  return basename(sourcePath) || "attachment";
}

function copySignalAttachment(params: {
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

function resolveSignalInboundAttachments(
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

async function transcribeSignalInboundAttachments(
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

function buildSignalMessageId(
  timestamp: number | null | undefined,
  author: string,
): string {
  const resolvedTimestamp =
    typeof timestamp === "number" && Number.isFinite(timestamp)
      ? String(timestamp)
      : String(Date.now());
  return `${resolvedTimestamp}:${author}`;
}

function parseReactionTargetMessageId(messageId: string): {
  targetTimestamp: number;
  targetAuthor?: string;
} {
  const [timestampPart, ...authorParts] = messageId.split(":");
  const targetTimestamp = Number(timestampPart);
  if (!Number.isFinite(targetTimestamp)) {
    throw new Error(
      "Signal reactions require a numeric target timestamp. Use the messageId from a Signal inbound message.",
    );
  }
  const targetAuthor = authorParts.join(":").trim() || undefined;
  return { targetTimestamp, targetAuthor };
}

function signalInboundFromPayload(
  payload: SignalReceivePayload,
  account: SignalChannelAccount,
): InboundChannelMessage | null {
  if (payload.exception?.message) {
    console.error(`[Signal] receive exception: ${payload.exception.message}`);
  }
  if (
    payload.account &&
    !signalIdentityMatchesAccount(payload.account, account)
  ) {
    return null;
  }
  let envelope = payload.envelope ?? undefined;
  if (!envelope) {
    return null;
  }
  if ("syncMessage" in envelope) {
    if (account.selfChatMode !== true) {
      return null;
    }
    envelope = envelopeFromSelfSyncMessage(envelope, account) ?? undefined;
    if (!envelope) {
      return null;
    }
  }
  const isOwnMessage = isOwnSignalMessage(envelope, account);
  if (isOwnMessage && account.selfChatMode !== true) {
    return null;
  }
  if (account.selfChatMode === true && !isOwnMessage) {
    return null;
  }

  const dataMessage =
    envelope.dataMessage ?? envelope.editMessage?.dataMessage ?? null;
  const reaction = envelope.reactionMessage ?? dataMessage?.reaction ?? null;
  const senderIdentity = envelope.sourceNumber ?? envelope.sourceUuid ?? null;
  if (!senderIdentity) {
    return null;
  }
  const replyRecipient =
    envelope.sourceNumber ??
    resolveSignalRecipientAlias(envelope.sourceUuid, account) ??
    envelope.sourceUuid ??
    null;

  const groupInfo = dataMessage?.groupInfo ?? reaction?.groupInfo ?? null;
  const groupId = groupInfo?.groupId ?? undefined;
  const isGroup = !!groupId;
  if (isGroup) {
    if ((account.groupMode ?? "disabled") === "disabled") {
      return null;
    }
    if (!isSignalGroupAllowed(account.allowedGroups, groupId)) {
      return null;
    }
  }

  const rawText = dataMessage?.message ?? "";
  const renderedText = renderSignalMentions(
    rawText,
    dataMessage?.mentions,
  ).trim();
  const attachments = dataMessage?.attachments ?? [];
  const attachmentPlaceholder = buildAttachmentPlaceholder(attachments);
  const text = renderedText || attachmentPlaceholder;
  const targetTimestamp =
    envelope.timestamp ??
    dataMessage?.timestamp ??
    reaction?.targetSentTimestamp ??
    Date.now();
  const resolvedTimestamp =
    typeof targetTimestamp === "number" ? targetTimestamp : Date.now();
  const downloadedAttachments = resolveSignalInboundAttachments(
    account,
    attachments,
    resolvedTimestamp,
  );
  const senderName = envelope.sourceName ?? senderIdentity;
  const chatId = isGroup ? `group:${groupId}` : `signal:${replyRecipient}`;
  const chatLabel = isGroup
    ? (groupInfo?.groupName ?? `Signal group ${groupId}`)
    : senderName;

  if (isGroup && (account.groupMode ?? "disabled") === "mention") {
    const isMention = matchesSignalMentionPatterns(
      text,
      account.mentionPatterns,
    );
    if (!isMention) {
      return null;
    }
  }

  if (!text && !reaction) {
    return null;
  }

  const baseMessage: InboundChannelMessage = {
    channel: "signal",
    accountId: account.accountId,
    chatId,
    chatType: isGroup ? "channel" : "direct",
    senderId: senderIdentity,
    senderName,
    chatLabel,
    text,
    timestamp: resolvedTimestamp,
    messageId: buildSignalMessageId(targetTimestamp, senderIdentity),
    threadId: null,
    isMention: isGroup
      ? matchesSignalMentionPatterns(text, account.mentionPatterns)
      : undefined,
    isOpenChannel: isGroup && (account.groupMode ?? "disabled") === "open",
    attachments:
      downloadedAttachments.length > 0 ? downloadedAttachments : undefined,
    raw: payload,
  };

  if (dataMessage?.quote) {
    baseMessage.replyContext = {
      senderId:
        dataMessage.quote.author ?? dataMessage.quote.authorUuid ?? undefined,
      senderName:
        dataMessage.quote.author ?? dataMessage.quote.authorUuid ?? undefined,
      text: dataMessage.quote.text ?? undefined,
    };
  }

  if (reaction?.emoji && reaction.targetSentTimestamp) {
    baseMessage.reaction = {
      action: reaction.isRemove ? "removed" : "added",
      emoji: reaction.emoji,
      targetMessageId: buildSignalMessageId(
        reaction.targetSentTimestamp,
        reaction.targetAuthor ?? reaction.targetAuthorUuid ?? senderIdentity,
      ),
      targetSenderId:
        reaction.targetAuthor ?? reaction.targetAuthorUuid ?? undefined,
    };
    if (!baseMessage.text) {
      baseMessage.text = `${senderName} reacted ${reaction.emoji}`;
    }
  }

  return baseMessage;
}

export function signalInboundFromSseEvent(
  event: SignalSseEvent,
  account: SignalChannelAccount,
): InboundChannelMessage | null {
  const payload = parseSignalEventData(event);
  if (!payload) {
    return null;
  }
  return signalInboundFromPayload(payload, account);
}

function getSignalTypingKey(source: ChannelTurnSource): string | null {
  if (source.channel !== "signal" || !source.chatId?.trim()) {
    return null;
  }
  return [
    source.accountId ?? "",
    source.chatId,
    source.messageId ?? "",
    source.agentId,
    source.conversationId,
  ].join(":");
}

export class SignalChannelAdapter implements ChannelAdapter {
  readonly id = "signal";
  readonly channelId = "signal";
  readonly accountId: string;
  readonly name = "Signal";

  onMessage?: (msg: InboundChannelMessage) => Promise<void>;

  private running = false;
  private abortController: AbortController | null = null;
  private eventLoop: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryResolve: (() => void) | null = null;
  private readonly typingByChatId = new Map<string, SignalTypingEntry>();
  private readonly client: SignalClientLike;
  private readonly retryMs: number;
  private logger?: ChannelAdapterStartOptions["logger"];

  constructor(
    private readonly account: SignalChannelAccount,
    options: SignalAdapterOptions = {},
  ) {
    this.accountId = account.accountId;
    this.client =
      options.client ??
      new SignalRestClient({
        baseUrl: account.baseUrl,
        account: account.account,
      });
    this.retryMs = options.retryMs ?? 5_000;
  }

  async start(options?: ChannelAdapterStartOptions): Promise<void> {
    if (this.running) {
      return;
    }
    await this.client.check();
    this.running = true;
    this.abortController = new AbortController();
    this.logger = options?.logger;
    this.logger?.(
      `[Signal] listening for ${this.account.account ?? this.account.accountId}`,
    );
    this.eventLoop = this.runEventLoop();
  }

  async stop(): Promise<void> {
    if (!this.running && !this.eventLoop) {
      return;
    }
    this.running = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryResolve?.();
    this.retryResolve = null;
    await this.stopAllTyping();
    this.abortController?.abort();
    await this.eventLoop?.catch(() => undefined);
    this.clearAllTyping();
    this.eventLoop = null;
    this.abortController = null;
    this.logger = undefined;
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendMessage(
    msg: OutboundChannelMessage,
  ): Promise<{ messageId: string }> {
    const target = parseSignalTarget(msg.chatId);
    if (
      this.account.selfChatMode === true &&
      !signalTargetMatchesAccount(target, this.account)
    ) {
      throw new Error(
        "Signal self-chat mode only permits replies to the linked account's own Note to Self chat.",
      );
    }
    if (msg.reaction || msg.targetMessageId) {
      if (!msg.reaction) {
        throw new Error("Signal reaction emoji is required.");
      }
      if (!msg.targetMessageId) {
        throw new Error("Signal reactions require messageId.");
      }
      const parsed = parseReactionTargetMessageId(msg.targetMessageId);
      const targetAuthor =
        parsed.targetAuthor ?? this.resolveDirectTargetAuthor(msg.chatId);
      if (!targetAuthor) {
        throw new Error(
          "Signal group reactions require the messageId from an inbound Signal message so targetAuthor is known.",
        );
      }
      const reactionParams: SignalReactionParams = {
        target,
        emoji: msg.reaction,
        targetTimestamp: parsed.targetTimestamp,
        targetAuthor,
        remove: msg.removeReaction === true,
      };
      await this.client.sendReaction(reactionParams);
      await this.stopTypingForChat(msg.chatId);
      return { messageId: msg.targetMessageId };
    }

    const attachments = msg.mediaPath ? [msg.mediaPath] : undefined;
    const messageId = await this.client.sendMessage({
      target,
      message: msg.text,
      attachments,
      textStyle: msg.textStyle,
    });
    await this.stopTypingForChat(msg.chatId);
    return { messageId };
  }

  async sendDirectReply(
    chatId: string,
    text: string,
    _options?: { replyToMessageId?: string },
  ): Promise<void> {
    await this.sendMessage({
      channel: "signal",
      accountId: this.accountId,
      chatId,
      text,
    });
  }

  async prepareInboundMessage(
    msg: InboundChannelMessage,
  ): Promise<InboundChannelMessage> {
    if (msg.channel !== "signal") {
      return msg;
    }
    return transcribeSignalInboundAttachments(this.account, msg);
  }

  async handleTurnLifecycleEvent(
    event: ChannelTurnLifecycleEvent,
  ): Promise<void> {
    if (!this.running) {
      return;
    }
    if (event.type === "queued") {
      return;
    }
    if (event.type === "processing") {
      for (const source of event.sources) {
        await this.startTypingForSource(source);
      }
      return;
    }
    for (const source of event.sources) {
      await this.stopTypingForSource(source);
    }
  }

  private async startTypingForSource(source: ChannelTurnSource): Promise<void> {
    const key = getSignalTypingKey(source);
    if (!key) {
      return;
    }
    await this.stopTypingForChat(key, { sendStop: false });
    const sendTyping = async (): Promise<boolean> => {
      try {
        await this.client.sendTyping({
          target: parseSignalTarget(source.chatId),
        });
        return true;
      } catch (error) {
        console.warn(
          `[Signal] Failed to send typing indicator for ${source.chatId}:`,
          error instanceof Error ? error.message : error,
        );
        return false;
      }
    };
    if (!(await sendTyping())) {
      return;
    }
    const timer = setInterval(() => {
      void sendTyping().then((ok) => {
        if (!ok) {
          void this.stopTypingForChat(key, { sendStop: false });
        }
      });
    }, SIGNAL_TYPING_REFRESH_MS);
    const timeout = setTimeout(() => {
      void this.stopTypingForChat(key);
    }, SIGNAL_TYPING_TIMEOUT_MS);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref?: () => void }).unref?.();
    }
    if (typeof (timeout as { unref?: () => void }).unref === "function") {
      (timeout as { unref?: () => void }).unref?.();
    }
    this.typingByChatId.set(key, {
      source,
      timer,
      timeout,
    });
  }

  private async stopTypingForSource(source: ChannelTurnSource): Promise<void> {
    const key = getSignalTypingKey(source);
    if (!key) {
      return;
    }
    await this.stopTypingForChat(key);
  }

  private async stopTypingForChat(
    chatId: string,
    options: { sendStop?: boolean } = {},
  ): Promise<void> {
    const directEntry = this.typingByChatId.get(chatId);
    const key = directEntry
      ? chatId
      : Array.from(this.typingByChatId.entries()).find(
          ([, entry]) => entry.source.chatId === chatId,
        )?.[0];
    if (!key) {
      return;
    }
    const entry = this.typingByChatId.get(key);
    if (!entry) {
      return;
    }
    clearInterval(entry.timer);
    clearTimeout(entry.timeout);
    this.typingByChatId.delete(key);
    if (options.sendStop === false) {
      return;
    }
    try {
      await this.client.sendTyping({
        target: parseSignalTarget(entry.source.chatId),
        stop: true,
      });
    } catch (error) {
      console.warn(
        `[Signal] Failed to stop typing indicator for ${entry.source.chatId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private clearAllTyping(): void {
    for (const entry of this.typingByChatId.values()) {
      clearInterval(entry.timer);
      clearTimeout(entry.timeout);
    }
    this.typingByChatId.clear();
  }

  private async stopAllTyping(): Promise<void> {
    await Promise.all(
      Array.from(this.typingByChatId.keys()).map((key) =>
        this.stopTypingForChat(key),
      ),
    );
  }

  private resolveDirectTargetAuthor(chatId: string): string | undefined {
    const target = parseSignalTarget(chatId);
    return target.kind === "recipient" ? target.recipient : undefined;
  }

  private async runEventLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.client.streamEvents(async (event) => {
          try {
            const msg = signalInboundFromSseEvent(event, this.account);
            if (!msg) {
              this.logger?.(
                `[Signal] ignored event account=${this.accountId} event=${event.event ?? "message"} id=${event.id ?? "<none>"}`,
              );
              return;
            }
            this.logger?.(
              `[Signal] inbound account=${this.accountId} chat=${msg.chatId} sender=${msg.senderId} type=${msg.chatType} chars=${msg.text.length} attachments=${msg.attachments?.length ?? 0}`,
            );
            await this.onMessage?.(msg);
          } catch (error) {
            console.error(
              `[Signal] failed to handle inbound event for ${this.accountId}:`,
              formatSignalAdapterError(error),
            );
            this.logger?.(
              `[Signal] failed inbound account=${this.accountId} event=${event.event ?? "message"} id=${event.id ?? "<none>"}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }, this.abortController?.signal);
      } catch (error) {
        if (!this.running) {
          return;
        }
        console.error(
          `[Signal] event stream failed for ${this.accountId}:`,
          formatSignalAdapterError(error),
        );
        this.logger?.(
          `[Signal] event stream failed account=${this.accountId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (this.running) {
        await new Promise<void>((resolve) => {
          this.retryResolve = resolve;
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.retryResolve = null;
            resolve();
          }, this.retryMs);
        });
      }
    }
  }
}

export function createSignalAdapter(
  account: SignalChannelAccount,
  options?: SignalAdapterOptions,
): SignalChannelAdapter {
  return new SignalChannelAdapter(account, options);
}
