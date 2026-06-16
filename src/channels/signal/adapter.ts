import type {
  ChannelAdapter,
  ChannelAdapterStartOptions,
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
