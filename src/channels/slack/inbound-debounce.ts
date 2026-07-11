import { createInboundDebouncer } from "@/channels/inbound-debounce";
import type { ChannelAdapter, SlackChannelAccount } from "@/channels/types";
import type {
  SlackDebounceEntry,
  SlackDebounceRawInput,
} from "./internal-types";
import { isNonEmptyString } from "./utils";

const APP_MENTION_RETRY_TTL_MS = 60_000;

export function buildSlackDebounceKey(
  rawMessage: SlackDebounceRawInput,
  accountId: string,
): string | null {
  const senderId = rawMessage.user ?? rawMessage.bot_id ?? null;
  if (!senderId) return null;
  const messageTs = rawMessage.ts ?? rawMessage.event_ts;
  const isDm = rawMessage.channel.startsWith("D");
  const scope = rawMessage.thread_ts
    ? `${rawMessage.channel}:${rawMessage.thread_ts}`
    : rawMessage.parent_user_id && messageTs
      ? `${rawMessage.channel}:maybe-thread:${messageTs}`
      : messageTs && !isDm
        ? `${rawMessage.channel}:${messageTs}`
        : rawMessage.channel;
  return `slack:${accountId}:${scope}:${senderId}`;
}

export function buildTopLevelSlackConversationKey(
  rawMessage: SlackDebounceRawInput,
  accountId: string,
): string | null {
  if (rawMessage.thread_ts || rawMessage.parent_user_id) return null;
  if (rawMessage.channel.startsWith("D")) return null;
  const senderId = rawMessage.user ?? rawMessage.bot_id;
  return senderId
    ? `slack:${accountId}:${rawMessage.channel}:${senderId}`
    : null;
}

export function resolveSlackInboundDebounceMs(
  config: Pick<SlackChannelAccount, "inboundDebounceMs">,
): number {
  const raw = process.env.LETTA_SLACK_INBOUND_DEBOUNCE_MS;
  if (typeof raw === "string" && raw.trim() !== "") {
    const envOverride = Number(raw);
    if (Number.isFinite(envOverride) && envOverride >= 0) {
      return Math.trunc(envOverride);
    }
  }
  const fromConfig = config.inboundDebounceMs;
  return typeof fromConfig === "number" &&
    Number.isFinite(fromConfig) &&
    fromConfig >= 0
    ? Math.trunc(fromConfig)
    : 0;
}

export type SlackInboundDebounceController = {
  dispatch: (entry: SlackDebounceEntry) => Promise<void>;
  rememberAppMentionRetry: (seenKey: string) => void;
  consumeAppMentionRetry: (seenKey: string) => boolean;
  clear: () => void;
};

export function createSlackInboundDebounceController(params: {
  config: Pick<SlackChannelAccount, "accountId" | "inboundDebounceMs">;
  getOnMessage: () => ChannelAdapter["onMessage"];
}): SlackInboundDebounceController {
  const { config } = params;
  const debounceMs = resolveSlackInboundDebounceMs(config);
  const pendingTopLevelKeys = new Map<string, Set<string>>();
  const appMentionRetryKeys = new Map<string, number>();
  const appMentionDispatchedKeys = new Map<string, number>();

  function pruneAppMentionMaps(now: number): void {
    for (const [key, expiresAt] of appMentionRetryKeys) {
      if (expiresAt <= now) appMentionRetryKeys.delete(key);
    }
    for (const [key, expiresAt] of appMentionDispatchedKeys) {
      if (expiresAt <= now) appMentionDispatchedKeys.delete(key);
    }
  }

  function dedupeEntries(entries: SlackDebounceEntry[]): SlackDebounceEntry[] {
    const indexByMessageKey = new Map<string, number>();
    const deduped: SlackDebounceEntry[] = [];
    for (const entry of entries) {
      const messageId = entry.inbound.messageId;
      const messageKey = isNonEmptyString(messageId)
        ? `${entry.inbound.chatId}:${messageId}`
        : null;
      if (!messageKey) {
        deduped.push(entry);
        continue;
      }
      const existingIndex = indexByMessageKey.get(messageKey);
      if (existingIndex === undefined) {
        indexByMessageKey.set(messageKey, deduped.length);
        deduped.push(entry);
        continue;
      }
      const current = deduped[existingIndex];
      if (
        current &&
        current.opts.source !== "app_mention" &&
        current.inbound.isMention !== true
      ) {
        deduped[existingIndex] = entry;
      }
    }
    return deduped;
  }

  const debouncer = createInboundDebouncer<SlackDebounceEntry>({
    debounceMs,
    buildKey: ({ raw }) => buildSlackDebounceKey(raw, config.accountId),
    shouldDebounce: ({ inbound }) =>
      !inbound.attachments?.length && !inbound.reaction,
    onFlush: async (entries) => {
      const dedupedEntries = dedupeEntries(entries);
      const last = dedupedEntries[dedupedEntries.length - 1];
      if (!last) return;

      const flushedKey = buildSlackDebounceKey(last.raw, config.accountId);
      const conversationKey = buildTopLevelSlackConversationKey(
        last.raw,
        config.accountId,
      );
      if (flushedKey && conversationKey) {
        const pending = pendingTopLevelKeys.get(conversationKey);
        pending?.delete(flushedKey);
        if (pending?.size === 0) pendingTopLevelKeys.delete(conversationKey);
      }

      if (isNonEmptyString(last.inbound.messageId)) {
        const seenKey = `${last.inbound.chatId}:${last.inbound.messageId}`;
        pruneAppMentionMaps(Date.now());
        if (last.opts.source === "app_mention") {
          appMentionDispatchedKeys.set(
            seenKey,
            Date.now() + APP_MENTION_RETRY_TTL_MS,
          );
        } else if (appMentionDispatchedKeys.has(seenKey)) {
          appMentionDispatchedKeys.delete(seenKey);
          appMentionRetryKeys.delete(seenKey);
          return;
        }
        appMentionRetryKeys.delete(seenKey);
      }

      const onMessage = params.getOnMessage();
      if (!onMessage) return;
      const text =
        dedupedEntries.length === 1
          ? last.inbound.text
          : dedupedEntries
              .map((entry) => entry.inbound.text)
              .filter(Boolean)
              .join("\n");
      try {
        await onMessage({
          ...last.inbound,
          text,
          isMention: dedupedEntries.some(
            (entry) =>
              entry.opts.wasMentioned || entry.inbound.isMention === true,
          ),
        });
      } catch (error) {
        console.error(
          "[Slack] Error handling debounced inbound message:",
          error,
        );
      }
    },
    onError: (error) => {
      console.error(
        "[Slack] Inbound debounce flush failed:",
        error instanceof Error ? error.message : error,
      );
    },
  });

  return {
    async dispatch(entry): Promise<void> {
      const debounceKey = buildSlackDebounceKey(entry.raw, config.accountId);
      const conversationKey = buildTopLevelSlackConversationKey(
        entry.raw,
        config.accountId,
      );
      const canDebounce =
        debounceMs > 0 &&
        !entry.inbound.attachments?.length &&
        !entry.inbound.reaction &&
        Boolean(debounceKey);
      if (!canDebounce && conversationKey) {
        for (const pendingKey of Array.from(
          pendingTopLevelKeys.get(conversationKey) ?? [],
        )) {
          try {
            await debouncer.flushKey(pendingKey);
          } catch {}
        }
      }
      if (canDebounce && debounceKey && conversationKey) {
        const pending =
          pendingTopLevelKeys.get(conversationKey) ?? new Set<string>();
        pending.add(debounceKey);
        pendingTopLevelKeys.set(conversationKey, pending);
      }
      await debouncer.enqueue(entry);
    },
    rememberAppMentionRetry(seenKey): void {
      const now = Date.now();
      pruneAppMentionMaps(now);
      appMentionRetryKeys.set(seenKey, now + APP_MENTION_RETRY_TTL_MS);
    },
    consumeAppMentionRetry(seenKey): boolean {
      pruneAppMentionMaps(Date.now());
      if (!appMentionRetryKeys.has(seenKey)) return false;
      appMentionRetryKeys.delete(seenKey);
      return true;
    },
    clear(): void {
      pendingTopLevelKeys.clear();
      appMentionRetryKeys.clear();
      appMentionDispatchedKeys.clear();
    },
  };
}
