/**
 * Bounded buffer for inbound channel deliveries while the registry is
 * disconnected.  Enforces a TTL (5 min) and max size (100) with user-facing
 * notifications on drop.
 */

import { isDebugEnabled } from "@/utils/debug";
import { LEGACY_CHANNEL_ACCOUNT_ID } from "./accounts";
import {
  buildChannelBufferExpiredMessage,
  buildChannelReconnectingMessage,
} from "./commands";
import type { ChannelInboundDelivery } from "./registry-handlers";
import type { ChannelAdapter } from "./types";

/** Delivery wrapped with a buffer timestamp for TTL enforcement. */
export interface BufferedDelivery {
  delivery: ChannelInboundDelivery;
  /** Epoch ms when this delivery was buffered. */
  bufferedAt: number;
  /** Channel + chat metadata for reconnecting/expired notifications. */
  channelId: string;
  accountId: string;
  chatId: string;
  threadId?: string | null;
  messageId?: string;
}

/** Max time a buffered delivery is kept before being dropped (5 minutes). */
const BUFFER_TTL_MS = 5 * 60 * 1000;

/** Max number of deliveries in the buffer before oldest are dropped. */
const BUFFER_MAX_SIZE = 100;

export type AdapterLookup = (
  channelId: string,
  accountId: string,
) => ChannelAdapter | null;

export type MessageHandler = (delivery: ChannelInboundDelivery) => void;

export interface ChannelBufferOptions {
  /**
   * Injectable clock for deterministic TTL testing.  Defaults to `Date.now`.
   * Production callers should never pass this — it exists so tests can
   * advance the buffer's internal clock without waiting real minutes.
   */
  now?: () => number;
}

export class ChannelBuffer {
  private readonly items: BufferedDelivery[] = [];
  private readonly now: () => number;

  constructor(options: ChannelBufferOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Send a "reconnecting" notification back through the channel adapter
   * so the user gets immediate feedback that their message is buffered.
   * Fire-and-forget: errors are swallowed to avoid disrupting the
   * inbound pipeline.
   */
  private notifyReconnecting(
    delivery: ChannelInboundDelivery,
    lookup: AdapterLookup,
  ): void {
    const source = delivery.turnSources?.[0];
    if (!source) return;

    const accountId = source.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    const adapter = lookup(source.channel, accountId);
    if (!adapter) return;

    const text = buildChannelReconnectingMessage(source.channel);
    adapter
      .sendDirectReply(source.chatId, text, {
        replyToMessageId: source.threadId ?? source.messageId,
      })
      .catch(() => {
        // Swallow — reconnecting notification is best-effort.
      });
  }

  /**
   * Notify the user that a buffered delivery was dropped (TTL expired or
   * max buffer size reached). Fire-and-forget.
   */
  private notifyBufferDrop(
    item: BufferedDelivery,
    reason: "ttl_expired" | "max_size",
    lookup: AdapterLookup,
  ): void {
    const adapter = lookup(item.channelId, item.accountId);
    if (!adapter) return;

    const text = buildChannelBufferExpiredMessage(item.channelId);
    adapter
      .sendDirectReply(item.chatId, text, {
        replyToMessageId: item.threadId ?? item.messageId,
      })
      .catch(() => {
        // Swallow — buffer-drop notification is best-effort.
      });

    if (isDebugEnabled()) {
      console.warn(
        `[Channels] Buffered delivery dropped (${reason}): channel=${item.channelId} accountId=${item.accountId} chatId=${item.chatId}`,
      );
    }
  }

  /**
   * Buffer a delivery (when not ready) or deliver immediately (when ready).
   * Derives notification metadata from the first turn source.
   */
  deliverOrBuffer(
    delivery: ChannelInboundDelivery,
    isReady: boolean,
    handler: MessageHandler | null,
    lookup: AdapterLookup,
  ): void {
    if (isReady && handler) {
      handler(delivery);
      return;
    }

    const source = delivery.turnSources?.[0];
    const channelId = source?.channel ?? "";
    const accountId = source?.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    const chatId = source?.chatId ?? "";
    const threadId = source?.threadId;
    const messageId = source?.messageId;

    // Enforce max buffer size: drop oldest if at capacity.
    while (this.items.length >= BUFFER_MAX_SIZE) {
      const dropped = this.items.shift();
      if (dropped) {
        this.notifyBufferDrop(dropped, "max_size", lookup);
      }
    }

    this.items.push({
      delivery,
      bufferedAt: this.now(),
      channelId,
      accountId,
      chatId,
      threadId,
      messageId,
    });

    // Send a reconnecting notification so the user gets immediate feedback.
    this.notifyReconnecting(delivery, lookup);
  }

  /**
   * Flush all buffered deliveries to the handler, dropping expired items
   * (TTL) from the front of the queue first.
   */
  flush(handler: MessageHandler, lookup: AdapterLookup): void {
    const now = this.now();

    // Drop expired items from the front of the queue.
    while (this.items.length > 0) {
      const item = this.items[0];
      if (!item) break;
      if (now - item.bufferedAt > BUFFER_TTL_MS) {
        this.items.shift();
        this.notifyBufferDrop(item, "ttl_expired", lookup);
        continue;
      }
      break;
    }

    while (this.items.length > 0) {
      const item = this.items.shift();
      if (item) {
        handler(item.delivery);
      }
    }
  }
}
