import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { getChannelDir } from "@/channels/config";
import type {
  ChannelAdapter,
  ChannelAdapterStartOptions,
  ChannelMessageAttachment,
  InboundChannelMessage,
  OutboundChannelMessage,
  SignalChannelAccount,
} from "@/channels/types";
import type { SignalReactionParams, SignalSseEvent } from "./client";
import { SignalRestClient } from "./client";
import {
  isSignalGroupAllowed,
  matchesSignalMentionPatterns,
  parseSignalTarget,
} from "./target";

export type SignalClientLike = Pick<
  SignalRestClient,
  "check" | "sendMessage" | "sendReaction" | "streamEvents"
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
  syncMessage?: unknown;
};

type SignalReceivePayload = {
  envelope?: SignalEnvelope | null;
  exception?: { message?: string | null } | null;
};

type SignalAttachmentCandidate = NonNullable<
  SignalDataMessage["attachments"]
>[number];

const DEFAULT_SIGNAL_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const MAX_SIGNAL_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
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
  const candidates = [
    attachment.localPath,
    attachment.path,
    attachment.storedFilename,
    attachment.filename,
  ];

  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) {
      continue;
    }
    if (isAbsolute(value) || value.includes("/") || value.includes("\\")) {
      try {
        const stat = statSync(value);
        if (stat.isFile()) {
          return value;
        }
      } catch {
        const resolvedRelative = resolveRelativeSignalAttachmentPath(value);
        if (resolvedRelative) {
          return resolvedRelative;
        }
      }
    }

    const resolvedRelative = resolveRelativeSignalAttachmentPath(value);
    if (resolvedRelative) {
      return resolvedRelative;
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

function resolveRelativeSignalAttachmentPath(value: string): string | null {
  const normalized = value.replace(/\\/g, "/");
  const suffix = normalized.startsWith("attachments/")
    ? normalized.slice("attachments/".length)
    : normalized;

  for (const baseDir of getSignalAttachmentSearchDirs()) {
    const directCandidate = join(baseDir, normalized);
    try {
      const stat = statSync(directCandidate);
      if (stat.isFile()) {
        return directCandidate;
      }
    } catch {
      // Try the basename-style fallback next.
    }

    const nestedCandidate = join(baseDir, suffix);
    try {
      const stat = statSync(nestedCandidate);
      if (stat.isFile()) {
        return nestedCandidate;
      }
    } catch {
      // Continue searching other signal-cli attachment dirs.
    }
  }

  return null;
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
): ChannelMessageAttachment[] {
  if (account.downloadMedia !== true || attachments.length === 0) {
    return [];
  }

  const maxBytes = account.mediaMaxBytes ?? DEFAULT_SIGNAL_MEDIA_MAX_BYTES;
  const resolved: ChannelMessageAttachment[] = [];
  const seenPaths = new Set<string>();

  for (const attachment of attachments) {
    const sourcePath = resolveSignalAttachmentPath(attachment);
    if (!sourcePath || seenPaths.has(sourcePath)) {
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
  const envelope = payload.envelope ?? undefined;
  if (!envelope) {
    return null;
  }
  if ("syncMessage" in envelope) {
    return null;
  }
  if (isOwnSignalMessage(envelope, account)) {
    return null;
  }

  const dataMessage =
    envelope.dataMessage ?? envelope.editMessage?.dataMessage ?? null;
  const reaction = envelope.reactionMessage ?? dataMessage?.reaction ?? null;
  const senderRecipient = envelope.sourceNumber ?? envelope.sourceUuid ?? null;
  if (!senderRecipient) {
    return null;
  }

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
  const downloadedAttachments = resolveSignalInboundAttachments(
    account,
    attachments,
  );
  const text = renderedText || attachmentPlaceholder;
  const targetTimestamp =
    envelope.timestamp ??
    dataMessage?.timestamp ??
    reaction?.targetSentTimestamp ??
    Date.now();
  const senderName = envelope.sourceName ?? senderRecipient;
  const chatId = isGroup ? `group:${groupId}` : `signal:${senderRecipient}`;
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
    senderId: senderRecipient,
    senderName,
    chatLabel,
    text,
    timestamp:
      typeof targetTimestamp === "number" ? targetTimestamp : Date.now(),
    messageId: buildSignalMessageId(targetTimestamp, senderRecipient),
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
        reaction.targetAuthor ?? reaction.targetAuthorUuid ?? senderRecipient,
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
  private readonly client: SignalClientLike;
  private readonly retryMs: number;

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
    options?.logger?.(
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
    this.abortController?.abort();
    await this.eventLoop?.catch(() => undefined);
    this.eventLoop = null;
    this.abortController = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendMessage(
    msg: OutboundChannelMessage,
  ): Promise<{ messageId: string }> {
    const target = parseSignalTarget(msg.chatId);
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
      return { messageId: msg.targetMessageId };
    }

    const attachments = msg.mediaPath ? [msg.mediaPath] : undefined;
    const messageId = await this.client.sendMessage({
      target,
      message: msg.text,
      attachments,
      textStyle: msg.textStyle,
    });
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

  private resolveDirectTargetAuthor(chatId: string): string | undefined {
    const target = parseSignalTarget(chatId);
    return target.kind === "recipient" ? target.recipient : undefined;
  }

  private async runEventLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.client.streamEvents(async (event) => {
          const msg = signalInboundFromSseEvent(event, this.account);
          if (!msg) {
            return;
          }
          await this.onMessage?.(msg);
        }, this.abortController?.signal);
      } catch (error) {
        if (!this.running) {
          return;
        }
        console.error(
          `[Signal] event stream failed for ${this.accountId}:`,
          error instanceof Error ? error.message : error,
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
