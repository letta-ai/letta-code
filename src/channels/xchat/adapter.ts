import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { evaluateChannelSenderAccess } from "@/channels/access-control";
import { formatChannelControlRequestPrompt } from "@/channels/interactive";
import type {
  ChannelAdapter,
  ChannelAdapterStartOptions,
  ChannelControlRequestEvent,
  ChannelTurnLifecycleEvent,
  ChannelTurnSource,
  CustomChannelAccount,
  InboundChannelMessage,
  OutboundChannelMessage,
} from "@/channels/types";
import { debugLog, debugWarn } from "@/utils/debug";
import {
  assertXChatAccountConfigured,
  readXChatAccountSettings,
  type XChatAccountSettings,
} from "./account";
import { XChatDeliveryQueue } from "./delivery-queue";
import { collectXChatAttachments, inferXChatUploadMimeType } from "./media";
import { patchXChatMediaUploadConversationIds } from "./media-upload-compat";
import { XChatPollState } from "./poll-state";
import {
  activityBackfillIsUnauthorized,
  fromThreadId,
  isGroupConversation,
  isRateLimitError,
  messageSequenceId,
  messageTimestamp,
  rateLimitDelayMs,
  rawEventId,
  rawEventIsUnverified,
  rawEventTimestamp,
  readActivityEvent,
  readReplyContext,
  safeErrorMessage,
  toThreadId,
} from "./protocol";
import {
  loadXChatSdkModule,
  loadXChatXdkModule,
  type XChatActivityStreamLike,
  type XChatApiClientLike,
  type XChatSdkAdapterLike,
  type XChatSdkLoggerLike,
  type XChatSdkMessageLike,
  type XChatSdkReactionLike,
  type XChatSdkWebhookOptionsLike,
} from "./runtime";

const XCHAT_CHANNEL_ID = "xchat";
const MAX_CONVERSATION_PAGES = 10;
const MAX_MESSAGES_PER_POLL = 50;
const MAX_MESSAGE_PAGES_PER_POLL = 1_000;
const ACTIVITY_RECONNECT_MS = 5_000;
const MAX_IN_FLIGHT_ACTIVITY_EVENTS = 32;
const DIRECT_REPLY_DEDUP_WINDOW_MS = 5_000;
const MAX_RECENT_DIRECT_REPLIES = 1_000;
const MAX_RECENT_REACTION_EVENTS = 1_000;
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

async function waitForPollToSettle(poll: Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, STOP_POLL_WAIT_MS);
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
  private readonly activityDeliveries = new Set<Promise<void>>();
  private activityBackfillSupported = true;
  private readonly discoveredConversationIds = new Set<string>();
  private readonly resolvedPeerUserIds = new Set<string>();
  private readonly typingChatIds = new Set<string>();
  private nextConversationSweepAtMs = 0;
  private readonly recentDirectReplies = new Map<
    string,
    { text: string; sentAtMs: number }
  >();
  private readonly recentReactionEventIds = new Set<string>();
  private running = false;
  private activePoll: Promise<void> | null = null;
  private readonly deliveryQueue = new XChatDeliveryQueue();
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
      // Activity events come from X's authenticated stream. We pass them
      // through the SDK's webhook parser so it also routes reaction events.
      disableWebhookVerification: true,
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
          handleIncomingMessage: async (
            _adapter: unknown,
            threadId: string,
            message: XChatSdkMessageLike,
          ) => {
            await this.deliverMessage(fromThreadId(threadId), message, false);
            this.pollState.save();
          },
          processReaction: (
            reaction: XChatSdkReactionLike,
            options?: XChatSdkWebhookOptionsLike,
          ) => {
            const delivery = this.deliverReaction(reaction);
            options?.waitUntil?.(delivery);
            return delivery;
          },
        }),
      );
      patchXChatMediaUploadConversationIds(sdkAdapter);
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
    this.pollDelayMs = this.fallbackSweepIntervalMs();
    this.running = true;
    try {
      await this.pollNow();
    } catch (error) {
      if (isRateLimitError(error)) {
        this.pollDelayMs = rateLimitDelayMs(
          error,
          Math.max(this.fallbackSweepIntervalMs(), this.pollDelayMs * 2),
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
    this.stopAllTyping();
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
    if (this.activityDeliveries.size > 0) {
      await waitForPollToSettle(
        Promise.all([...this.activityDeliveries]).then(() => undefined),
      );
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
      this.stopTyping(message.chatId);
      return { messageId: sent.id };
    }

    const sent = await sdkAdapter.postMessage(threadId, message.text);
    this.stopTyping(message.chatId);
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

  async handleTurnLifecycleEvent(
    event: ChannelTurnLifecycleEvent,
  ): Promise<void> {
    if (!this.running) return;
    if (event.type === "queued") {
      await this.startTyping(event.source);
      return;
    }
    if (event.type === "processing") {
      await Promise.all(
        event.sources.map((source) => this.startTyping(source)),
      );
      return;
    }
    for (const source of event.sources) {
      this.stopTyping(source.chatId);
    }
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
      this.pollDelayMs = this.fallbackSweepIntervalMs();
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
          this.pollDelayMs = rateLimitDelayMs(
            error,
            Math.max(this.fallbackSweepIntervalMs(), this.pollDelayMs * 2),
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

  private fallbackSweepIntervalMs(): number {
    return this.activityClient
      ? SWEEP_WITH_ACTIVITY_MS
      : Math.max(SWEEP_WITHOUT_ACTIVITY_MS, this.settings.pollIntervalMs);
  }

  private async startTyping(source: ChannelTurnSource): Promise<void> {
    if (
      source.channel !== XCHAT_CHANNEL_ID ||
      source.accountId !== this.accountId ||
      isGroupConversation(source.chatId)
    ) {
      return;
    }
    const sdkAdapter = this.sdkAdapter;
    if (!sdkAdapter?.startTyping) return;
    if (this.typingChatIds.has(source.chatId)) return;
    this.typingChatIds.add(source.chatId);
    try {
      await sdkAdapter.startTyping(toThreadId(source.chatId));
    } catch (error) {
      this.typingChatIds.delete(source.chatId);
      debugWarn(
        "X Chat",
        `typing indicator failed: ${safeErrorMessage(error)}`,
      );
    }
  }

  private stopTyping(chatId: string): void {
    if (!this.typingChatIds.delete(chatId)) return;
    this.sdkAdapter?.stopTyping?.(chatId);
  }

  private stopAllTyping(): void {
    for (const chatId of this.typingChatIds) {
      this.sdkAdapter?.stopTyping?.(chatId);
    }
    this.typingChatIds.clear();
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
            if (this.activityDeliveries.size >= MAX_IN_FLIGHT_ACTIVITY_EVENTS) {
              await Promise.race(this.activityDeliveries);
            }
            this.trackActivityEvent(event);
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

  private async handleActivityEvent(event: unknown): Promise<void> {
    const { incoming, conversationId } = readActivityEvent(event);
    if (!conversationId) return;
    if (isGroupConversation(conversationId)) return;
    this.discoveredConversationIds.add(conversationId);
    if (!incoming || !this.sdkAdapter) return;
    try {
      if (this.sdkAdapter.handleWebhook) {
        const body = JSON.stringify({
          data: {
            event_type: "chat.received",
            payload: {
              id: incoming.id,
              conversation_id: incoming.conversationId,
              sender_id: incoming.senderId,
              encoded_event: incoming.encodedEvent,
              conversation_key_version: incoming.conversationKeyVersion,
              conversation_key_change_event:
                incoming.conversationKeyChangeEvent,
              conversation_token: incoming.conversationToken,
              encrypted_conversation_key: incoming.encryptedConversationKey,
              created_at_msec: incoming.createdAtMsec,
              message_event_signature: incoming.messageEventSignature,
              sequence_id: incoming.sequenceId,
            },
          },
        });
        const pending: Promise<unknown>[] = [];
        const response = await this.sdkAdapter.handleWebhook(
          new Request("http://localhost/xchat-activity", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
          { waitUntil: (task) => pending.push(task) },
        );
        if (!response.ok) {
          throw new Error(
            `X Chat SDK rejected activity event (${response.status})`,
          );
        }
        await Promise.all(pending);
      } else {
        await this.sdkAdapter.handleIncomingEvent?.(incoming);
      }
    } catch (error) {
      debugWarn(
        "X Chat",
        `activity event failed: ${safeErrorMessage(error)}; the safety sweep will retry it`,
      );
    }
  }

  private async deliverReaction(reaction: XChatSdkReactionLike): Promise<void> {
    const conversationId = fromThreadId(reaction.threadId);
    await this.deliveryQueue.run(conversationId, async () => {
      if (!this.running || reaction.user.isMe) return;
      if (rawEventIsUnverified(reaction.raw)) return;
      const eventId = rawEventId(reaction.raw);
      if (eventId && this.recentReactionEventIds.has(eventId)) return;

      const rawEmoji = reaction.rawEmoji?.trim();
      const emoji = rawEmoji || reaction.emoji?.name?.trim();
      if (!emoji || !reaction.messageId) return;
      await this.onMessage?.({
        channel: XCHAT_CHANNEL_ID,
        accountId: this.account.accountId,
        chatId: conversationId,
        senderId: reaction.user.userId,
        senderName:
          reaction.user.fullName || reaction.user.userName || undefined,
        chatLabel: reaction.user.userName,
        text: `X Chat reaction ${reaction.added ? "added" : "removed"}: ${emoji}`,
        timestamp: rawEventTimestamp(reaction.raw),
        messageId: eventId ?? reaction.messageId,
        threadId: null,
        raw: reaction.raw,
        chatType: "direct",
        routedBy: "dm",
        reaction: {
          action: reaction.added ? "added" : "removed",
          emoji,
          targetMessageId: reaction.messageId,
        },
      });
      if (eventId) {
        this.recentReactionEventIds.add(eventId);
        while (this.recentReactionEventIds.size > MAX_RECENT_REACTION_EVENTS) {
          const oldest = this.recentReactionEventIds.values().next().value;
          if (typeof oldest !== "string") break;
          this.recentReactionEventIds.delete(oldest);
        }
      }
    });
  }

  private trackActivityEvent(event: unknown): void {
    let delivery: Promise<void>;
    delivery = this.handleActivityEvent(event).catch((error) => {
      debugWarn(
        "X Chat",
        `activity event dispatch failed: ${safeErrorMessage(error)}`,
      );
    });
    this.activityDeliveries.add(delivery);
    void delivery.finally(() => {
      this.activityDeliveries.delete(delivery);
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
      const delivered = await this.deliverMessage(
        conversationId,
        message,
        bootstrapping && messageTimestamp(message) < cutoff,
      );
      if (delivered) {
        await sdkAdapter
          .markAsRead?.(threadId, message.id, message)
          .catch((error) => {
            debugWarn(
              "X Chat",
              `read receipt failed: ${safeErrorMessage(error)}`,
            );
          });
      }
    }
  }

  private async deliverMessage(
    conversationId: string,
    message: XChatSdkMessageLike,
    suppressDelivery: boolean,
  ): Promise<boolean> {
    return this.deliveryQueue.run(conversationId, () =>
      this.deliverMessageUnlocked(conversationId, message, suppressDelivery),
    );
  }

  private async deliverMessageUnlocked(
    conversationId: string,
    message: XChatSdkMessageLike,
    suppressDelivery: boolean,
  ): Promise<boolean> {
    if (!this.running) return false;
    const timestamp = messageTimestamp(message);
    const sequenceId = messageSequenceId(message);
    if (
      !message.id ||
      this.pollState.has(conversationId, message.id, timestamp, sequenceId)
    ) {
      return false;
    }
    const shouldDeliver = message.author?.isMe !== true && !suppressDelivery;
    if (shouldDeliver) {
      const canProcessMedia =
        evaluateChannelSenderAccess({
          account: this.account,
          channelId: XCHAT_CHANNEL_ID,
          senderId: message.author.userId,
          chatType: "direct",
        }) === "allow";
      const attachments = await collectXChatAttachments({
        accountId: this.accountId,
        chatId: conversationId,
        messageId: message.id,
        attachments: message.attachments ?? [],
        downloadMedia: this.settings.downloadMedia && canProcessMedia,
        mediaMaxBytes: this.settings.mediaMaxBytes,
        transcribeVoice: this.settings.transcribeVoice && canProcessMedia,
      });
      if (!this.running) return false;
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
        replyContext: readReplyContext(message.raw),
      });
    }
    this.pollState.add(conversationId, message.id, timestamp, sequenceId);
    return shouldDeliver;
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
