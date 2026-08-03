import { createInboundDebouncer } from "@/channels/inbound-debounce";
import type {
  InboundChannelMessage,
  WhatsAppChannelAccount,
} from "@/channels/types";
import { stripDeviceSuffix } from "./jid";

const MAX_WHATSAPP_INBOUND_DEBOUNCE_MS = 10_000;

type MaybePromise<T> = T | Promise<T>;

export interface WhatsAppInboundReadReceipt<TOwner, TKey> {
  owner: TOwner;
  key: TKey;
  markRead: (keys: TKey[]) => MaybePromise<unknown>;
}

export interface WhatsAppInboundDebounceEntry<TOwner, TKey> {
  inbound: InboundChannelMessage;
  receipt?: WhatsAppInboundReadReceipt<TOwner, TKey>;
  onDeliveryStarted?: () => void;
  onDiscarded?: () => void;
}

interface PendingWhatsAppInboundDebounceEntry<TOwner, TKey>
  extends WhatsAppInboundDebounceEntry<TOwner, TKey> {
  generation: number;
}

export interface WhatsAppInboundDebounceController<TOwner, TKey> {
  dispatch(
    entries: WhatsAppInboundDebounceEntry<TOwner, TKey>[],
  ): Promise<void>;
  flushAll(): Promise<void>;
  cancelPending(): void;
}

export interface WhatsAppInboundDebounceControllerParams<TOwner, TKey> {
  account: Pick<WhatsAppChannelAccount, "accountId" | "inboundDebounceMs">;
  getDeliver: () =>
    | ((message: InboundChannelMessage) => Promise<void>)
    | undefined;
  onDeliveryError?: (
    error: unknown,
    entries: WhatsAppInboundDebounceEntry<TOwner, TKey>[],
  ) => void;
  onReadReceiptError?: (error: unknown, keys: TKey[]) => void;
}

export function resolveWhatsAppInboundDebounceMs(
  account: Pick<WhatsAppChannelAccount, "inboundDebounceMs">,
): number {
  const value = account.inboundDebounceMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.trunc(Math.min(value, MAX_WHATSAPP_INBOUND_DEBOUNCE_MS));
}

function shouldDebounceMessage(message: InboundChannelMessage): boolean {
  return message.text.trim().length > 0 && !(message.attachments?.length ?? 0);
}

function buildDebounceKey(message: InboundChannelMessage): string {
  return [
    message.accountId ?? "",
    stripDeviceSuffix(message.chatId),
    stripDeviceSuffix(message.senderId),
  ].join(":");
}

function mergeInboundMessages<TOwner, TKey>(
  entries: WhatsAppInboundDebounceEntry<TOwner, TKey>[],
): InboundChannelMessage {
  const latest = entries[entries.length - 1]?.inbound;
  if (!latest) {
    throw new Error("Cannot merge an empty WhatsApp inbound debounce batch.");
  }
  return {
    ...latest,
    text: entries
      .map((entry) => entry.inbound.text.trim())
      .filter((text) => text.length > 0)
      .join("\n"),
    raw: entries.map((entry) => entry.inbound.raw),
  };
}

export function createWhatsAppInboundDebounceController<TOwner, TKey>(
  params: WhatsAppInboundDebounceControllerParams<TOwner, TKey>,
): WhatsAppInboundDebounceController<TOwner, TKey> {
  const debounceMs = resolveWhatsAppInboundDebounceMs(params.account);
  let generation = 0;
  const pendingEntries = new Set<WhatsAppInboundDebounceEntry<TOwner, TKey>>();

  const startDelivery = (
    entries: WhatsAppInboundDebounceEntry<TOwner, TKey>[],
  ): void => {
    for (const entry of entries) {
      if (!pendingEntries.delete(entry)) continue;
      try {
        entry.onDeliveryStarted?.();
      } catch {
        // Claim bookkeeping must not block inbound delivery.
      }
    }
  };

  const discard = (
    entries: WhatsAppInboundDebounceEntry<TOwner, TKey>[],
  ): void => {
    for (const entry of entries) {
      if (!pendingEntries.delete(entry)) continue;
      try {
        entry.onDiscarded?.();
      } catch {
        // Claim bookkeeping must not break cancellation.
      }
    }
  };

  const reportDeliveryError = (
    error: unknown,
    entries: WhatsAppInboundDebounceEntry<TOwner, TKey>[],
  ): void => {
    try {
      params.onDeliveryError?.(error, entries);
    } catch {
      // Error reporting must not break the debounce pipeline.
    }
  };

  const reportReadReceiptError = (error: unknown, keys: TKey[]): void => {
    try {
      params.onReadReceiptError?.(error, keys);
    } catch {
      // Receipt error reporting is best-effort.
    }
  };

  const startReadReceipts = (
    entries: WhatsAppInboundDebounceEntry<TOwner, TKey>[],
  ): void => {
    const groups = new Map<
      TOwner,
      { keys: TKey[]; markRead: (keys: TKey[]) => MaybePromise<unknown> }
    >();
    for (const entry of entries) {
      if (!entry.receipt) continue;
      const existing = groups.get(entry.receipt.owner);
      if (existing) {
        existing.keys.push(entry.receipt.key);
        continue;
      }
      groups.set(entry.receipt.owner, {
        keys: [entry.receipt.key],
        markRead: entry.receipt.markRead,
      });
    }

    for (const { keys, markRead } of groups.values()) {
      if (keys.length === 0) continue;
      try {
        const result = markRead(keys);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          void (result as Promise<unknown>).catch((error) => {
            reportReadReceiptError(error, keys);
          });
        }
      } catch (error) {
        reportReadReceiptError(error, keys);
      }
    }
  };

  const deliver = async (
    entries: WhatsAppInboundDebounceEntry<TOwner, TKey>[],
  ): Promise<boolean> => {
    const deliverMessage = params.getDeliver();
    const first = entries[0];
    if (!deliverMessage || !first) {
      discard(entries);
      return false;
    }
    const inbound =
      entries.length === 1 ? first.inbound : mergeInboundMessages(entries);
    startDelivery(entries);
    await deliverMessage(inbound);
    return true;
  };

  const debouncer = createInboundDebouncer<
    PendingWhatsAppInboundDebounceEntry<TOwner, TKey>
  >({
    debounceMs,
    buildKey: (entry) => buildDebounceKey(entry.inbound),
    shouldDebounce: (entry) => shouldDebounceMessage(entry.inbound),
    onFlush: async (entries) => {
      const activeEntries = entries.filter(
        (entry) => entry.generation === generation,
      );
      discard(entries.filter((entry) => entry.generation !== generation));
      if (activeEntries.length === 0) return;
      const delivered = await deliver(activeEntries);
      if (
        delivered &&
        activeEntries.every((entry) => entry.generation === generation)
      ) {
        startReadReceipts(activeEntries);
      }
    },
    onError: (error, entries) => {
      discard(entries);
      reportDeliveryError(error, entries);
    },
  });

  return {
    async dispatch(entries) {
      if (entries.length === 0) return;
      for (const entry of entries) pendingEntries.add(entry);
      const entryGeneration = generation;
      if (debounceMs === 0) {
        const deliveredEntries: WhatsAppInboundDebounceEntry<TOwner, TKey>[] =
          [];
        for (const entry of entries) {
          if (entryGeneration !== generation) {
            discard(entries);
            return;
          }
          try {
            if (await deliver([entry])) {
              deliveredEntries.push(entry);
            }
          } catch (error) {
            reportDeliveryError(error, [entry]);
          }
        }
        if (entryGeneration === generation) {
          startReadReceipts(deliveredEntries);
        }
        return;
      }
      await Promise.all(
        entries.map((entry) => {
          const pendingEntry = { ...entry, generation: entryGeneration };
          pendingEntries.delete(entry);
          pendingEntries.add(pendingEntry);
          return debouncer.enqueue(pendingEntry);
        }),
      );
    },
    async flushAll() {
      await debouncer.flushAll();
    },
    cancelPending() {
      generation += 1;
      discard(Array.from(pendingEntries));
      debouncer.cancelAll();
    },
  };
}
