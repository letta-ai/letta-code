import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getChannelDir } from "@/channels/config";
import { isRecord } from "@/utils/type-guards";

type ConversationPollState = {
  watermarkMs: number;
  watermarkSequenceId?: string;
  messageIdsAtWatermark: Set<string>;
};

type PersistedPollState = {
  version: 2;
  conversations: Record<
    string,
    {
      watermark_ms: number;
      watermark_sequence_id?: string;
      message_ids_at_watermark: string[];
    }
  >;
};

function compareSequenceIds(left: string, right: string): number | null {
  try {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  } catch {
    return null;
  }
}

function getPollStatePath(accountId: string): string {
  return join(getChannelDir("xchat"), `poll-state-${accountId}.json`);
}

export class XChatPollState {
  private readonly conversations = new Map<string, ConversationPollState>();
  private dirty = true;

  constructor(private readonly accountId: string) {
    this.load();
  }

  get isEmpty(): boolean {
    return this.conversations.size === 0;
  }

  get conversationIds(): string[] {
    return [...this.conversations.keys()];
  }

  hasConversation(conversationId: string): boolean {
    return this.conversations.has(conversationId);
  }

  has(
    conversationId: string,
    messageId: string,
    timestamp: number,
    sequenceId?: string,
  ): boolean {
    const state = this.conversations.get(conversationId);
    if (!state) return false;
    if (sequenceId && state.watermarkSequenceId) {
      const comparison = compareSequenceIds(
        sequenceId,
        state.watermarkSequenceId,
      );
      if (comparison !== null) {
        if (comparison < 0) return true;
        if (comparison > 0) return false;
        return state.messageIdsAtWatermark.has(messageId);
      }
    }
    if (timestamp < state.watermarkMs) return true;
    if (timestamp > state.watermarkMs) return false;
    return state.messageIdsAtWatermark.has(messageId);
  }

  add(
    conversationId: string,
    messageId: string,
    timestamp: number,
    sequenceId?: string,
  ): void {
    if (!conversationId || !messageId || !Number.isFinite(timestamp)) return;
    const state = this.conversations.get(conversationId);
    const sequenceComparison =
      sequenceId && state?.watermarkSequenceId
        ? compareSequenceIds(sequenceId, state.watermarkSequenceId)
        : null;
    if (sequenceComparison !== null && sequenceComparison > 0) {
      this.conversations.set(conversationId, {
        watermarkMs: Math.max(timestamp, state?.watermarkMs ?? timestamp),
        watermarkSequenceId: sequenceId,
        messageIdsAtWatermark: new Set([messageId]),
      });
      this.dirty = true;
      return;
    }
    if (sequenceComparison === 0 && state) {
      if (!state.messageIdsAtWatermark.has(messageId)) {
        state.messageIdsAtWatermark.add(messageId);
        state.watermarkMs = Math.max(state.watermarkMs, timestamp);
        this.dirty = true;
      }
      return;
    }
    if (!state || timestamp > state.watermarkMs) {
      this.conversations.set(conversationId, {
        watermarkMs: timestamp,
        watermarkSequenceId: sequenceId ?? state?.watermarkSequenceId,
        messageIdsAtWatermark: new Set([messageId]),
      });
      this.dirty = true;
      return;
    }
    if (
      timestamp === state.watermarkMs &&
      !state.messageIdsAtWatermark.has(messageId)
    ) {
      state.messageIdsAtWatermark.add(messageId);
      this.dirty = true;
    }
  }

  save(): void {
    const path = getPollStatePath(this.accountId);
    if (!this.dirty && existsSync(path)) return;
    mkdirSync(getChannelDir("xchat"), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    const conversations: PersistedPollState["conversations"] = {};
    for (const [conversationId, state] of this.conversations) {
      conversations[conversationId] = {
        watermark_ms: state.watermarkMs,
        ...(state.watermarkSequenceId
          ? { watermark_sequence_id: state.watermarkSequenceId }
          : {}),
        message_ids_at_watermark: [...state.messageIdsAtWatermark],
      };
    }
    const payload: PersistedPollState = { version: 2, conversations };
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(tmp, path);
    this.dirty = false;
  }

  private load(): void {
    const path = getPollStatePath(this.accountId);
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      if (
        !isRecord(parsed) ||
        parsed.version !== 2 ||
        !isRecord(parsed.conversations)
      ) {
        return;
      }
      for (const [conversationId, value] of Object.entries(
        parsed.conversations,
      )) {
        if (
          !isRecord(value) ||
          typeof value.watermark_ms !== "number" ||
          !Array.isArray(value.message_ids_at_watermark)
        ) {
          continue;
        }
        const messageIds = value.message_ids_at_watermark.filter(
          (entry): entry is string => typeof entry === "string",
        );
        this.conversations.set(conversationId, {
          watermarkMs: value.watermark_ms,
          watermarkSequenceId:
            typeof value.watermark_sequence_id === "string"
              ? value.watermark_sequence_id
              : undefined,
          messageIdsAtWatermark: new Set(messageIds),
        });
      }
      this.dirty = false;
    } catch {
      // A damaged state file is replaced after the next successful poll.
    }
  }
}
