import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { formatChannelControlRequestPrompt } from "@/channels/interactive";
import type {
  ChannelAdapter,
  ChannelAdapterStartOptions,
  ChannelControlRequestEvent,
  CustomChannelAccount,
  InboundChannelMessage,
  OutboundChannelMessage,
} from "@/channels/types";
import { debugLog, debugWarn } from "@/utils/debug";
import { isRecord } from "@/utils/type-guards";
import {
  assertXChatAccountConfigured,
  readXChatAccountSettings,
  type XChatAccountSettings,
} from "./account";
import { describeXChatAttachments, inferXChatUploadMimeType } from "./media";
import { XChatPollState } from "./poll-state";
import {
  loadXChatSdkModule,
  loadXChatXdkModule,
  type XChatActivityStreamLike,
  type XChatApiClientLike,
  type XChatSdkAdapterLike,
  type XChatSdkLoggerLike,
  type XChatSdkMessageLike,
} from "./runtime";

const XCHAT_CHANNEL_ID = "xchat";
const XCHAT_THREAD_PREFIX = "xchat:";
const MAX_CONVERSATION_PAGES = 10;
const MAX_MESSAGES_PER_POLL = 50;
const MAX_MESSAGE_PAGES_PER_POLL = 1_000;
const MAX_POLL_BACKOFF_MS = 60_000;
const ACTIVITY_RECONNECT_MS = 5_000;
const DIRECT_REPLY_DEDUP_WINDOW_MS = 5_000;
const MAX_RECENT_DIRECT_REPLIES = 1_000;
const SWEEP_WITH_ACTIVITY_MS = 60_000;
const SWEEP_WITHOUT_ACTIVITY_MS = 8_000;
const STOP_POLL_WAIT_MS = 250;
const MAX_OUTBOUND_MEDIA_BYTES = 50 * 1024 * 1024;

let xchatInitializationTail = Promise.resolve();

async function runSerializedXChatInitialization<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = xchatInitializationTail;
  let release: () => void = () => {};
  xchatInitializationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function toThreadId(chatId: string): string {
  return chatId.startsWith(XCHAT_THREAD_PREFIX)
    ? chatId
    : `${XCHAT_THREAD_PREFIX}${chatId}`;
}

function fromThreadId(threadId: string): string {
  const conversationId = threadId.startsWith(XCHAT_THREAD_PREFIX)
    ? threadId.slice(XCHAT_THREAD_PREFIX.length)
    : threadId;
  return /^\d+-\d+$/.test(conversationId)
    ? conversationId.replace("-", ":")
    : conversationId;
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  return error.message.replace(/xcbot_[A-Za-z0-9._-]+/g, "[redacted]");
}

function activityBackfillIsUnauthorized(error: unknown): boolean {
  if (!isRecord(error) || !isRecord(error.data)) return false;
  const errors = error.data.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some(
    (entry) =>
      isRecord(entry) &&
      typeof entry.message === "string" &&
      entry.message.includes("backfill_minutes"),
  );
}

function createSdkLogger(): XChatSdkLoggerLike {
  const logger: XChatSdkLoggerLike = {
    debug(message) {
      debugLog("X Chat", message);
    },
    info(message) {
      debugLog("X Chat", message);
    },
    warn(message) {
      debugWarn("X Chat", message);
    },
    error(message) {
      debugWarn("X Chat", message);
    },
    child() {
      return logger;
    },
  };
  return logger;
}

function messageTimestamp(message: XChatSdkMessageLike): number {
  const value = message.metadata?.dateSent;
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function messageSequenceId(message: XChatSdkMessageLike): string | undefined {
  if (!isRecord(message.raw)) return undefined;
  const event = message.raw.event;
  const decrypted = message.raw.decrypted;
  for (const source of [event, decrypted]) {
    if (!isRecord(source)) continue;
    const value = source.sequenceId ?? source.sequence_id;
    if (typeof value === "string" && /^\d+$/.test(value)) return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      return String(value);
    }
  }
  return undefined;
}

function isGroupConversation(conversationId: string): boolean {
  return conversationId.startsWith("g");
}

function isRateLimitError(error: unknown): boolean {
  if (isRecord(error)) {
    const status = error.status ?? error.statusCode;
    if (status === 429) return true;
  }
  return /\b429\b|too many requests/i.test(safeErrorMessage(error));
}

async function waitForPollToSettle(poll: Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, STOP_POLL_WAIT_MS);
    timer.unref?.();
    void poll.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

export class XChatChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly channelId = XCHAT_CHANNEL_ID;
  readonly accountId: string;
  readonly name: string;
  onMessage?: (msg: InboundChannelMessage) => Promise<void>;

  private readonly settings: XChatAccountSettings;
  private readonly pollState: XChatPollState;
  private sdkAdapter: XChatSdkAdapterLike | null = null;
  private apiClient: XChatApiClientLike | null = null;
  private activityClient: XChatApiClientLike | null = null;
  private activityStream: XChatActivityStreamLike | null = null;
  private activityAbortController: AbortController | null = null;
  private activityTask: Promise<void> | null = null;
  private activityBackfillSupported = true;
  private readonly discoveredConversationIds = new Set<string>();
  private readonly resolvedPeerUserIds = new Set<string>();
  private nextConversationSweepAtMs = 0;
  private readonly recentDirectReplies = new Map<
    string,
    { text: string; sentAtMs: number }
  >();
  private running = false;
  private activePoll: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pollDelayMs: number;
  private startupLogger?: (message: string) => void;

  constructor(private readonly account: CustomChannelAccount) {
    this.id = `xchat:${account.accountId}`;
    this.accountId = account.accountId;
    this.name = account.displayName || "X Chat";
    this.settings = readXChatAccountSettings(account);
    this.pollState = new XChatPollState(account.accountId);
    this.pollDelayMs = this.settings.pollIntervalMs;
  }

  async start(options?: ChannelAdapterStartOptions): Promise<void> {
    if (this.running) return;
    assertXChatAccountConfigured(this.settings);
    this.startupLogger = options?.logger;

    const [sdkModule, xdkModule] = await Promise.all([
      loadXChatSdkModule(),
      loadXChatXdkModule(),
    ]);
    const sdkAdapter = sdkModule.createXchatAdapter({
      botToken: this.settings.botToken,
      pin: this.settings.pin,
      verifySignatures: true,
      sendReadReceipts: true,
      logger: createSdkLogger(),
    });
    const apiClient = new xdkModule.Client({
      accessToken: this.settings.botToken,
      headers: { "user-agent": "letta-code-xchat/0.1" },
    });
    const activityClient = this.settings.activityToken
      ? new xdkModule.Client({
          accessToken: this.settings.botToken,
          bearerToken: this.settings.activityToken,
          headers: { "user-agent": "letta-code-xchat/0.1" },
        })
      : null;

    try {
      await runSerializedXChatInitialization(() =>
        sdkAdapter.initialize({
          getLogger: () => createSdkLogger(),
          getUserName: () => sdkAdapter.userName,
          handleIncomingMessage: async () => {},
          processReaction: async () => {},
        }),
      );
      if (sdkAdapter.cryptoStatus !== "ready") {
        throw new Error(
          `X Chat encryption is ${sdkAdapter.cryptoStatus}; check the configured PIN.`,
        );
      }
    } catch (error) {
      await sdkAdapter.disconnect?.();
      throw error;
    }

    this.sdkAdapter = sdkAdapter;
    this.apiClient = apiClient;
    this.activityClient = activityClient;
    this.running = true;
    try {
      await this.pollNow();
    } catch (error) {
      if (isRateLimitError(error)) {
        this.pollDelayMs = Math.min(
          Math.max(this.settings.pollIntervalMs, this.pollDelayMs * 2),
          MAX_POLL_BACKOFF_MS,
        );
        debugWarn(
          "X Chat",
          `initial poll rate limited; retrying in ${this.pollDelayMs}ms`,
        );
      } else {
        this.running = false;
        this.sdkAdapter = null;
        this.apiClient = null;
        this.activityClient = null;
        await sdkAdapter.disconnect?.();
        throw error;
      }
    }
    if (activityClient) {
      await this.startActivityDiscovery();
    }
    if (!this.running) return;
    this.scheduleNextPoll();
    const identity = sdkAdapter.userName ? `@${sdkAdapter.userName}` : "bot";
    const discovery = activityClient
      ? "activity stream enabled"
      : "primary inbox only; configure the app Bearer token for Message requests";
    this.startupLogger?.(`X Chat connected as ${identity} (${discovery})`);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.activePoll) {
      await waitForPollToSettle(this.activePoll);
      this.activePoll = null;
    }
    const activityStream = this.activityStream;
    if (activityStream?.reader) {
      try {
        // XDK's close() releases a locked reader and reports an InvalidStateError.
        // Cancel the reader first so its pending read completes normally.
        await activityStream.reader.cancel();
      } catch {
        this.activityAbortController?.abort();
      }
    } else {
      this.activityAbortController?.abort();
    }
    this.activityAbortController = null;
    this.activityStream = null;
    if (this.activityTask) {
      await waitForPollToSettle(this.activityTask);
      this.activityTask = null;
    }
    const sdkAdapter = this.sdkAdapter;
    this.sdkAdapter = null;
    this.apiClient = null;
    this.activityClient = null;
    await sdkAdapter?.disconnect?.();
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendMessage(
    message: OutboundChannelMessage,
  ): Promise<{ messageId: string }> {
    const sdkAdapter = this.requireSdkAdapter();
    const threadId = toThreadId(message.chatId);

    if (isGroupConversation(message.chatId)) {
      throw new Error(
        "X Chat group sending is not supported because the upstream adapter cannot bind a reply to the triggering message.",
      );
    }
    if (message.replyToMessageId) {
      throw new Error("X Chat does not support explicit reply targets.");
    }

    if (message.targetMessageId && message.reaction) {
      if (message.removeReaction) {
        await sdkAdapter.removeReaction(
          threadId,
          message.targetMessageId,
          message.reaction,
        );
      } else {
        await sdkAdapter.addReaction(
          threadId,
          message.targetMessageId,
          message.reaction,
        );
      }
      return { messageId: message.targetMessageId };
    }

    if (message.mediaPath) {
      const file = await stat(message.mediaPath);
      if (file.size > MAX_OUTBOUND_MEDIA_BYTES) {
        throw new Error(
          `X Chat attachments must be ${MAX_OUTBOUND_MEDIA_BYTES} bytes or smaller.`,
        );
      }
      const bytes = await readFile(message.mediaPath);
      if (bytes.byteLength > MAX_OUTBOUND_MEDIA_BYTES) {
        throw new Error(
          `X Chat attachments must be ${MAX_OUTBOUND_MEDIA_BYTES} bytes or smaller.`,
        );
      }
      const filename = message.fileName?.trim() || basename(message.mediaPath);
      const sent = await sdkAdapter.postMessage(threadId, {
        raw: message.text,
        files: [
          {
            data: bytes,
            filename,
            mimeType: inferXChatUploadMimeType(filename),
          },
        ],
      });
      return { messageId: sent.id };
    }

    const sent = await sdkAdapter.postMessage(threadId, message.text);
    return { messageId: sent.id };
  }

  async sendDirectReply(chatId: string, text: string): Promise<void> {
    const previous = this.recentDirectReplies.get(chatId);
    const now = Date.now();
    if (
      previous?.text === text &&
      now - previous.sentAtMs < DIRECT_REPLY_DEDUP_WINDOW_MS
    ) {
      return;
    }
    await this.sendMessage({
      channel: XCHAT_CHANNEL_ID,
      accountId: this.account.accountId,
      chatId,
      text,
    });
    if (
      !this.recentDirectReplies.has(chatId) &&
      this.recentDirectReplies.size >= MAX_RECENT_DIRECT_REPLIES
    ) {
      const oldestChatId = this.recentDirectReplies.keys().next().value;
      if (oldestChatId) this.recentDirectReplies.delete(oldestChatId);
    }
    this.recentDirectReplies.set(chatId, { text, sentAtMs: Date.now() });
  }

  async handleControlRequestEvent(
    event: ChannelControlRequestEvent,
  ): Promise<void> {
    if (event.source.chatType === "channel") return;
    await this.sendDirectReply(
      event.source.chatId,
      formatChannelControlRequestPrompt(event),
    );
  }

  async pollNow(): Promise<void> {
    if (!this.running) return;
    if (this.activePoll) return this.activePoll;
    const poll = this.performPoll();
    this.activePoll = poll;
    try {
      await poll;
    } finally {
      if (this.activePoll === poll) this.activePoll = null;
    }
  }

  private async performPoll(): Promise<void> {
    try {
      const conversationIds = await this.listConversationIds();
      for (const conversationId of conversationIds) {
        if (!this.running) break;
        try {
          await this.pollConversation(
            conversationId,
            !this.pollState.hasConversation(conversationId),
          );
        } catch (error) {
          debugWarn(
            "X Chat",
            `conversation poll failed for ${conversationId}: ${safeErrorMessage(error)}`,
          );
          if (isRateLimitError(error)) throw error;
        }
      }
      this.pollDelayMs = this.settings.pollIntervalMs;
    } finally {
      this.pollState.save();
    }
  }

  private scheduleNextPoll(): void {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollNow()
        .catch((error) => {
          debugWarn("X Chat", `poll failed: ${safeErrorMessage(error)}`);
          this.pollDelayMs = Math.min(
            Math.max(this.settings.pollIntervalMs, this.pollDelayMs * 2),
            MAX_POLL_BACKOFF_MS,
          );
        })
        .finally(() => this.scheduleNextPoll());
    }, this.pollDelayMs);
  }

  private async listConversationIds(): Promise<string[]> {
    const apiClient = this.requireApiClient();
    const ids = new Set<string>([
      ...this.pollState.conversationIds,
      ...this.discoveredConversationIds,
    ]);
    const now = Date.now();
    if (now < this.nextConversationSweepAtMs) return [...ids];
    this.nextConversationSweepAtMs =
      now +
      (this.activityClient
        ? SWEEP_WITH_ACTIVITY_MS
        : SWEEP_WITHOUT_ACTIVITY_MS);
    let paginationToken: string | undefined;
    for (let page = 0; page < MAX_CONVERSATION_PAGES; page += 1) {
      const response = await apiClient.chat.getConversations({
        maxResults: 100,
        paginationToken,
        chatConversationFields: ["id", "type", "updated_at"],
      });
      for (const conversation of response.data ?? []) {
        const id =
          conversation.id ??
          conversation.conversationId ??
          conversation.conversation_id;
        if (id) {
          const conversationId = fromThreadId(String(id));
          if (!isGroupConversation(conversationId)) ids.add(conversationId);
        }
      }
      paginationToken =
        response.meta?.nextToken ?? response.meta?.next_token ?? undefined;
      if (!paginationToken) break;
    }
    for (const peerUserId of this.settings.peerUserIds) {
      if (this.resolvedPeerUserIds.has(peerUserId)) continue;
      try {
        const response = await apiClient.chat.getConversation?.(peerUserId);
        const id = response?.data?.id;
        if (id) {
          const conversationId = fromThreadId(String(id));
          if (!isGroupConversation(conversationId)) {
            ids.add(conversationId);
            this.discoveredConversationIds.add(conversationId);
            this.resolvedPeerUserIds.add(peerUserId);
          }
        }
      } catch (error) {
        if (isRateLimitError(error)) throw error;
        debugWarn(
          "X Chat",
          `peer conversation lookup failed: ${safeErrorMessage(error)}`,
        );
      }
    }
    return [...ids];
  }

  private async startActivityDiscovery(): Promise<void> {
    const apiClient = this.requireApiClient();
    const activityClient = this.activityClient;
    if (!activityClient?.stream?.activity) return;
    for (const eventType of ["chat.received", "chat.conversation.join"]) {
      try {
        await apiClient.activity?.createSubscription({
          eventType,
          filter: { userId: this.sdkAdapter?.botUserId ?? "" },
        });
      } catch (error) {
        debugLog(
          "X Chat",
          `activity subscription ${eventType}: ${safeErrorMessage(error)}`,
        );
      }
    }
    this.activityAbortController = new AbortController();
    let initialStream: XChatActivityStreamLike | null = null;
    try {
      initialStream = await this.openActivityStream();
    } catch (error) {
      debugWarn(
        "X Chat",
        `activity stream unavailable; retrying: ${safeErrorMessage(error)}`,
      );
    }
    this.activityStream = initialStream;
    this.activityTask = this.consumeActivityStreams(initialStream);
  }

  private async consumeActivityStreams(
    initialStream: XChatActivityStreamLike | null,
  ): Promise<void> {
    let stream: XChatActivityStreamLike | null = initialStream;
    while (this.running) {
      if (stream) {
        try {
          for await (const event of stream) {
            if (!this.running) return;
            this.handleActivityEvent(event);
          }
        } catch (error) {
          if (this.running) {
            debugWarn(
              "X Chat",
              `activity stream failed: ${safeErrorMessage(error)}`,
            );
          }
        } finally {
          if (this.activityStream === stream) this.activityStream = null;
        }
      }
      if (!this.running) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ACTIVITY_RECONNECT_MS);
        timer.unref?.();
      });
      if (!this.running) return;
      try {
        stream = await this.openActivityStream();
        this.activityStream = stream;
      } catch (error) {
        debugWarn(
          "X Chat",
          `activity reconnect failed: ${safeErrorMessage(error)}`,
        );
        stream = null;
      }
    }
  }

  private async openActivityStream(): Promise<XChatActivityStreamLike> {
    const streamClient = this.activityClient?.stream;
    if (!streamClient) throw new Error("X Chat activity stream is unavailable");
    const signal = this.activityAbortController?.signal;
    try {
      return await streamClient.activity(
        this.activityBackfillSupported
          ? { backfillMinutes: 5, signal }
          : { signal },
      );
    } catch (error) {
      if (
        this.activityBackfillSupported &&
        activityBackfillIsUnauthorized(error)
      ) {
        this.activityBackfillSupported = false;
        debugLog(
          "X Chat",
          "activity-stream backfill is unavailable; connecting without backfill",
        );
        return streamClient.activity({ signal });
      }
      throw error;
    }
  }

  private handleActivityEvent(event: unknown): void {
    if (!isRecord(event)) return;
    const envelope = isRecord(event.data) ? event.data : event;
    const payload = isRecord(envelope.payload) ? envelope.payload : envelope;
    const rawConversationId = payload.conversationId ?? payload.conversation_id;
    if (typeof rawConversationId !== "string" || !rawConversationId) return;
    const conversationId = fromThreadId(rawConversationId);
    if (isGroupConversation(conversationId)) return;
    this.discoveredConversationIds.add(conversationId);
    void this.pollNow().catch((error) => {
      debugWarn("X Chat", `activity poll failed: ${safeErrorMessage(error)}`);
    });
  }

  private async pollConversation(
    conversationId: string,
    bootstrapping: boolean,
  ): Promise<void> {
    const sdkAdapter = this.requireSdkAdapter();
    const threadId = toThreadId(conversationId);
    const messages: XChatSdkMessageLike[] = [];
    const cutoff =
      Date.now() - this.settings.bootstrapLookbackMinutes * 60 * 1_000;
    let cursor: string | undefined;
    let paginationComplete = false;
    for (let page = 0; page < MAX_MESSAGE_PAGES_PER_POLL; page += 1) {
      const result = await sdkAdapter.fetchMessages(threadId, {
        limit: MAX_MESSAGES_PER_POLL,
        cursor,
      });
      messages.push(...result.messages);
      if (!this.running) break;
      const reachedKnownMessage = result.messages.some((message) =>
        this.pollState.has(
          conversationId,
          message.id,
          messageTimestamp(message),
          messageSequenceId(message),
        ),
      );
      const reachedBootstrapCutoff =
        bootstrapping &&
        result.messages.some((message) => messageTimestamp(message) < cutoff);
      cursor = result.nextCursor;
      if (reachedKnownMessage || reachedBootstrapCutoff || !cursor) {
        paginationComplete = true;
        break;
      }
    }
    if (this.running && !paginationComplete && cursor) {
      throw new Error(
        `X Chat backlog for ${conversationId} exceeds ${MAX_MESSAGE_PAGES_PER_POLL * MAX_MESSAGES_PER_POLL} events; refusing to advance the checkpoint.`,
      );
    }
    messages.sort(
      (left, right) => messageTimestamp(left) - messageTimestamp(right),
    );
    for (const message of messages) {
      if (!this.running) break;
      const timestamp = messageTimestamp(message);
      if (
        !message.id ||
        this.pollState.has(
          conversationId,
          message.id,
          timestamp,
          messageSequenceId(message),
        )
      ) {
        continue;
      }
      const shouldDeliver =
        message.author?.isMe !== true &&
        (!bootstrapping || timestamp >= cutoff);

      if (shouldDeliver) {
        const attachments = describeXChatAttachments(
          message.id,
          message.attachments ?? [],
        );
        await this.onMessage?.({
          channel: XCHAT_CHANNEL_ID,
          accountId: this.account.accountId,
          chatId: conversationId,
          senderId: message.author.userId,
          senderName:
            message.author.fullName || message.author.userName || undefined,
          chatLabel: message.author.userName,
          text: message.text,
          timestamp,
          messageId: message.id,
          threadId: null,
          raw: message.raw,
          chatType: "direct",
          routedBy: "dm",
          attachments: attachments.length > 0 ? attachments : undefined,
        });
        await sdkAdapter
          .markAsRead?.(threadId, message.id, message)
          .catch((error) => {
            debugWarn(
              "X Chat",
              `read receipt failed: ${safeErrorMessage(error)}`,
            );
          });
      }
      this.pollState.add(
        conversationId,
        message.id,
        timestamp,
        messageSequenceId(message),
      );
    }
  }

  private requireSdkAdapter(): XChatSdkAdapterLike {
    if (!this.sdkAdapter || !this.running) {
      throw new Error("X Chat adapter is not running.");
    }
    return this.sdkAdapter;
  }

  private requireApiClient(): XChatApiClientLike {
    if (!this.apiClient || !this.running) {
      throw new Error("X Chat API client is not running.");
    }
    return this.apiClient;
  }
}

export function createXChatAdapter(
  account: CustomChannelAccount,
): XChatChannelAdapter {
  return new XChatChannelAdapter(account);
}
