import type { InboundDebouncer } from "@/channels/inbound-debounce";
import { createInboundDebouncer } from "@/channels/inbound-debounce";
import type { ChannelAdapter, InboundChannelMessage } from "@/channels/types";
import { stripDeviceSuffix } from "./jid";

export interface WhatsAppInboundReceipt<TKey> {
  /** The exact socket (or equivalent emitter) that produced the entry. */
  owner: object;
  key: TKey;
  markRead: (keys: TKey[]) => unknown;
}

export interface WhatsAppInboundDebounceEntry<TKey> {
  inbound: InboundChannelMessage;
  receipt?: WhatsAppInboundReceipt<TKey>;
}

export interface WhatsAppInboundDebounceOptions {
  accountId: string;
  debounceMs?: number;
  getDeliver: () => ChannelAdapter["onMessage"];
  onDeliveryError?: (error: unknown, message: InboundChannelMessage) => void;
  onReceiptError?: (error: unknown) => void;
}

export interface WhatsAppInboundDebounceController<TKey> {
  dispatch(entries: WhatsAppInboundDebounceEntry<TKey>[]): Promise<void>;
  flushAll(): Promise<void>;
}

const MAX_DEBOUNCE_MS = 10_000;

function clampDebounceMs(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return 0;
  return Math.min(MAX_DEBOUNCE_MS, Math.max(0, Math.trunc(value)));
}

function buildDebounceKey(
  accountId: string,
  inbound: InboundChannelMessage,
): string {
  return [
    accountId,
    stripDeviceSuffix(inbound.chatId),
    stripDeviceSuffix(inbound.senderId),
  ].join(":");
}

function shouldDebounce(inbound: InboundChannelMessage): boolean {
  return (
    inbound.text.trim().length > 0 &&
    (inbound.attachments?.length ?? 0) === 0 &&
    inbound.reaction === undefined
  );
}

function mergeEntries<TKey>(
  entries: WhatsAppInboundDebounceEntry<TKey>[],
): InboundChannelMessage {
  const latest = entries[entries.length - 1]?.inbound;
  if (!latest) {
    throw new Error("Cannot merge an empty WhatsApp inbound batch.");
  }
  if (entries.length === 1) return latest;

  return {
    ...latest,
    text: entries
      .map((entry) => entry.inbound.text.trim())
      .filter((text) => text.length > 0)
      .join("\n"),
    raw: entries.map((entry) => entry.inbound.raw),
  };
}

export function createWhatsAppInboundDebounceController<TKey>(
  options: WhatsAppInboundDebounceOptions,
): WhatsAppInboundDebounceController<TKey> {
  const debounceMs = clampDebounceMs(options.debounceMs);

  function reportDeliveryError(
    error: unknown,
    message: InboundChannelMessage,
  ): void {
    try {
      options.onDeliveryError?.(error, message);
    } catch {
      // Error reporting must not break the generic key chain.
    }
  }

  function reportReceiptError(error: unknown): void {
    try {
      options.onReceiptError?.(error);
    } catch {
      // Receipt errors are deliberately contained.
    }
  }

  function startReceipts(entries: WhatsAppInboundDebounceEntry<TKey>[]): void {
    const groups = new Map<
      object,
      { keys: TKey[]; markRead: (keys: TKey[]) => unknown }
    >();
    for (const entry of entries) {
      const receipt = entry.receipt;
      if (!receipt) continue;
      const group = groups.get(receipt.owner);
      if (group) group.keys.push(receipt.key);
      else {
        groups.set(receipt.owner, {
          keys: [receipt.key],
          markRead: receipt.markRead,
        });
      }
    }
    for (const group of groups.values()) {
      try {
        void Promise.resolve(group.markRead(group.keys)).catch(
          reportReceiptError,
        );
      } catch (error) {
        reportReceiptError(error);
      }
    }
  }

  function invokeDelivery(message: InboundChannelMessage): Promise<void> {
    const deliver = options.getDeliver();
    if (!deliver) return Promise.resolve();
    try {
      return Promise.resolve(deliver(message)).catch((error) => {
        reportDeliveryError(error, message);
      });
    } catch (error) {
      reportDeliveryError(error, message);
      return Promise.resolve();
    }
  }

  const debouncer: InboundDebouncer<WhatsAppInboundDebounceEntry<TKey>> =
    createInboundDebouncer({
      debounceMs,
      buildKey: (entry) => buildDebounceKey(options.accountId, entry.inbound),
      shouldDebounce: (entry) => shouldDebounce(entry.inbound),
      onFlush: async (entries) => {
        const delivery = invokeDelivery(mergeEntries(entries));
        startReceipts(entries);
        await delivery;
      },
    });

  async function dispatch(
    entries: WhatsAppInboundDebounceEntry<TKey>[],
  ): Promise<void> {
    if (entries.length === 0) return;
    if (debounceMs === 0) {
      for (const entry of entries) await invokeDelivery(entry.inbound);
      startReceipts(entries);
      return;
    }
    await Promise.all(entries.map((entry) => debouncer.enqueue(entry)));
  }
  return {
    dispatch,
    flushAll: debouncer.flushAll,
  };
}
