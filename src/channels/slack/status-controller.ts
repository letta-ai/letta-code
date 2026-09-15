import type {
  ChannelTurnLifecycleEvent,
  ChannelTurnSource,
  OutboundChannelMessage,
} from "@/channels/types";
import { SLACK_ASSISTANT_STARTUP_STATUS } from "./progress";
import {
  firstNonEmptyString,
  isNonEmptyString,
  resolveSlackChatType,
  resolveSlackProgressThreadTs,
  resolveSlackSourceThreadTs,
} from "./public-utils";

const SLACK_ASSISTANT_STATUS_KEEPALIVE_MS = 90_000;

export interface SlackStatusWriteClient {
  assistant?: {
    threads?: {
      setStatus?: (args: {
        channel_id: string;
        thread_ts: string;
        status: string;
        loading_messages?: string[];
      }) => Promise<unknown>;
    };
  };
}

export type AgentConvSlackState = {
  isThinkingActive: boolean;
  thinkingText: string;
  typingFooterText: string;
};

export type SlackStatusController = {
  handleLifecycle: (event: ChannelTurnLifecycleEvent) => Promise<void>;
  getUniqueSources: (sources: ChannelTurnSource[]) => ChannelTurnSource[];
  getLifecycleErrorReplyKey: (source: ChannelTurnSource) => string | null;
  activate: (
    source: ChannelTurnSource,
    footerText: string,
    loadingText: string,
  ) => Promise<void>;
  deactivate: (source: ChannelTurnSource) => Promise<void>;
  clearStale: (source: ChannelTurnSource) => Promise<void>;
  markAutoCleared: (source: ChannelTurnSource) => void;
  /** Transfer ownership without allowing old writes to clear the new owner. */
  relinquish: (source: ChannelTurnSource) => void;
  markAutoClearedForMessage: (
    msg: Pick<
      OutboundChannelMessage,
      "agentId" | "conversationId" | "chatId" | "threadId" | "replyToMessageId"
    >,
  ) => void;
  activeSources: () => ChannelTurnSource[];
  clear: () => void;
};

export function createSlackStatusController(params: {
  ensureApp: () => Promise<unknown>;
  ensureWriteClient: () => Promise<SlackStatusWriteClient>;
  resolveKnownThreadRoot: (messageId: string) => string;
}): SlackStatusController {
  const stateByConversation = new Map<string, AgentConvSlackState>();
  const sourceByConversation = new Map<string, ChannelTurnSource>();
  const signatureByConversation = new Map<string, string>();
  const revisionByConversation = new Map<string, number>();
  const relinquishedThroughRevision = new Map<string, number>();
  const outstandingWrites = new Map<
    string,
    Set<{ replyKey: string; revision: number }>
  >();
  let nextRevision = 0;

  function advanceRevision(key: string): number {
    const revision = ++nextRevision;
    revisionByConversation.set(key, revision);
    return revision;
  }

  function currentRevision(key: string): number {
    return revisionByConversation.get(key) ?? advanceRevision(key);
  }

  function ownedReplyKey(key: string): string | null {
    const source = sourceByConversation.get(key);
    return source ? getLifecycleReplyKey(source) : null;
  }
  const writePromiseByConversation = new Map<string, Promise<void>>();
  const keepaliveByConversation = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  const clearedStaleReplyKeys = new Set<string>();

  function getConversationKey(source: ChannelTurnSource): string | null {
    return source.channel === "slack" &&
      isNonEmptyString(source.agentId) &&
      isNonEmptyString(source.conversationId)
      ? `${source.agentId}:${source.conversationId}`
      : null;
  }

  function getLifecycleReplyKey(source: ChannelTurnSource): string | null {
    if (source.channel !== "slack" || !isNonEmptyString(source.chatId)) {
      return null;
    }
    const replyToMessageId = resolveSlackProgressThreadTs(source);
    return isNonEmptyString(replyToMessageId)
      ? `${source.chatId}:${replyToMessageId}`
      : null;
  }

  function getLifecycleErrorReplyKey(source: ChannelTurnSource): string | null {
    if (source.channel !== "slack" || !isNonEmptyString(source.chatId)) {
      return null;
    }
    if (
      source.chatType === "direct" ||
      resolveSlackChatType(source.chatId) === "direct"
    ) {
      const replyToMessageId = resolveSlackSourceThreadTs(source);
      return isNonEmptyString(replyToMessageId)
        ? `${source.chatId}:${replyToMessageId}`
        : `${source.chatId}:direct`;
    }
    return getLifecycleReplyKey(source);
  }

  function getUniqueSources(sources: ChannelTurnSource[]): ChannelTurnSource[] {
    const seen = new Set<string>();
    const unique: ChannelTurnSource[] = [];
    for (const source of sources) {
      const key = getConversationKey(source);
      if (!key || seen.has(key) || !getLifecycleReplyKey(source)) continue;
      seen.add(key);
      unique.push(source);
    }
    return unique;
  }

  function clearKeepalive(key: string): void {
    const timer = keepaliveByConversation.get(key);
    if (timer) {
      clearTimeout(timer);
      keepaliveByConversation.delete(key);
    }
  }

  async function writeStatus(
    source: ChannelTurnSource,
    footerText: string,
    loadingText: string,
    options: { force?: boolean } = {},
  ): Promise<boolean> {
    const stateKey = getConversationKey(source);
    const replyKey = getLifecycleReplyKey(source);
    const threadTs = resolveSlackProgressThreadTs(source);
    if (!stateKey || !replyKey || !threadTs) return false;

    // State objects are mutable. Capture a revision before either asynchronous
    // preparation or the write queue, rather than comparing object identity.
    const revision = currentRevision(stateKey);
    const revocationKey = JSON.stringify([stateKey, replyKey]);
    const canWrite = (): boolean => {
      const current = revisionByConversation.get(stateKey);
      if (
        current === undefined ||
        revision <= (relinquishedThroughRevision.get(revocationKey) ?? 0)
      )
        return false;
      const active = stateByConversation.get(stateKey)?.isThinkingActive;
      if (footerText) {
        return (
          current === revision &&
          Boolean(active) &&
          ownedReplyKey(stateKey) === replyKey
        );
      }
      // An obsolete clear may still clean its OLD thread, but must never blank
      // newer activity occupying that same Slack thread.
      return (
        current === revision || !active || ownedReplyKey(stateKey) !== replyKey
      );
    };
    const signature = `${revision}\n${replyKey}\n${footerText}\n${loadingText}`;
    if (!options.force && signatureByConversation.get(stateKey) === signature) {
      return true;
    }

    // Normal reply cleanup drops activeSources, but a later handoff still
    // needs the exact identity of writes that can issue a correction.
    const writes = outstandingWrites.get(stateKey) ?? new Set();
    const pendingWrite = { replyKey, revision };
    writes.add(pendingWrite);
    outstandingWrites.set(stateKey, writes);
    try {
      await params.ensureApp();
      const slackClient = await params.ensureWriteClient();
      const setStatus = slackClient.assistant?.threads?.setStatus;
      if (!setStatus || !canWrite()) return false;

      if (revisionByConversation.get(stateKey) === revision) {
        signatureByConversation.set(stateKey, signature);
      }
      const previous =
        writePromiseByConversation.get(stateKey) ?? Promise.resolve();
      const operation = previous.then(async () => {
        // Source, title, reply or completion may have changed while queued.
        if (!canWrite()) {
          if (signatureByConversation.get(stateKey) === signature) {
            signatureByConversation.delete(stateKey);
          }
          return false;
        }
        try {
          await setStatus.call(slackClient.assistant?.threads, {
            channel_id: source.chatId,
            thread_ts: threadTs,
            status: footerText,
            ...(footerText ? { loading_messages: [loadingText] } : {}),
          });
          // The request may have applied after a reply auto-cleared Slack. Keep
          // this correction in the same write queue, ahead of any new activity.
          const state = stateByConversation.get(stateKey);
          if (
            footerText &&
            revision > (relinquishedThroughRevision.get(revocationKey) ?? 0) &&
            state &&
            (!state.isThinkingActive || ownedReplyKey(stateKey) !== replyKey)
          ) {
            await setStatus.call(slackClient.assistant?.threads, {
              channel_id: source.chatId,
              thread_ts: threadTs,
              status: "",
            });
            clearedStaleReplyKeys.add(replyKey);
            return true;
          }
          if (footerText) clearedStaleReplyKeys.delete(replyKey);
          else clearedStaleReplyKeys.add(replyKey);
          return true;
        } catch (error) {
          if (signatureByConversation.get(stateKey) === signature) {
            signatureByConversation.delete(stateKey);
          }
          console.warn(
            "[Slack] Failed to update assistant thread status:",
            error instanceof Error ? error.message : error,
          );
          return false;
        }
      });
      const settled = operation.then(() => undefined);
      writePromiseByConversation.set(stateKey, settled);
      void settled.then(() => {
        if (writePromiseByConversation.get(stateKey) === settled) {
          writePromiseByConversation.delete(stateKey);
        }
      });
      return await operation;
    } finally {
      writes.delete(pendingWrite);
      if (writes.size === 0 && outstandingWrites.get(stateKey) === writes)
        outstandingWrites.delete(stateKey);
    }
  }

  function scheduleKeepalive(key: string): void {
    clearKeepalive(key);
    const timer = setTimeout(() => {
      keepaliveByConversation.delete(key);
      void (async () => {
        const state = stateByConversation.get(key);
        const source = sourceByConversation.get(key);
        if (!state?.isThinkingActive || !source) return;
        const revision = currentRevision(key);
        await writeStatus(source, state.typingFooterText, state.thinkingText, {
          force: true,
        });
        if (
          revisionByConversation.get(key) === revision &&
          state.isThinkingActive
        )
          scheduleKeepalive(key);
      })();
    }, SLACK_ASSISTANT_STATUS_KEEPALIVE_MS);
    timer.unref?.();
    keepaliveByConversation.set(key, timer);
  }

  async function activate(
    source: ChannelTurnSource,
    footerText: string,
    loadingText: string,
  ): Promise<void> {
    const key = getConversationKey(source);
    if (!key || !getLifecycleReplyKey(source)) return;
    const state = stateByConversation.get(key) ?? {
      isThinkingActive: false,
      thinkingText: "",
      typingFooterText: "",
    };
    if (
      state.isThinkingActive &&
      state.thinkingText === loadingText &&
      state.typingFooterText === footerText &&
      ownedReplyKey(key) === getLifecycleReplyKey(source)
    ) {
      sourceByConversation.set(key, source);
      return;
    }
    const revision = advanceRevision(key);
    state.isThinkingActive = true;
    state.thinkingText = loadingText;
    state.typingFooterText = footerText;
    stateByConversation.set(key, state);
    sourceByConversation.set(key, source);
    const sent = await writeStatus(source, footerText, loadingText);
    if (revisionByConversation.get(key) !== revision) return;
    if (sent && state.isThinkingActive) scheduleKeepalive(key);
    else if (!sent) state.isThinkingActive = false;
  }

  function markAutoClearedByKey(key: string): void {
    advanceRevision(key);
    clearKeepalive(key);
    const state = stateByConversation.get(key);
    if (state) state.isThinkingActive = false;
    signatureByConversation.delete(key);
    sourceByConversation.delete(key);
  }

  async function deactivate(source: ChannelTurnSource): Promise<void> {
    const key = getConversationKey(source);
    if (!key) return;
    if (
      stateByConversation.get(key)?.isThinkingActive &&
      ownedReplyKey(key) !== getLifecycleReplyKey(source)
    ) {
      await writeStatus(source, "", "", { force: true });
      return;
    }
    const revision = advanceRevision(key);
    clearKeepalive(key);
    const state = stateByConversation.get(key);
    if (state) state.isThinkingActive = false;
    signatureByConversation.delete(key);
    sourceByConversation.delete(key);
    await writeStatus(source, "", "", { force: true });
    if (revisionByConversation.get(key) !== revision) return;
    signatureByConversation.delete(key);
    stateByConversation.delete(key);
  }

  async function clearStale(source: ChannelTurnSource): Promise<void> {
    const key = getConversationKey(source);
    const replyKey = getLifecycleReplyKey(source);
    if (
      !key ||
      !replyKey ||
      stateByConversation.get(key)?.isThinkingActive ||
      clearedStaleReplyKeys.has(replyKey)
    ) {
      return;
    }
    const revision = currentRevision(key);
    await writeStatus(source, "", "", { force: true });
    if (revisionByConversation.get(key) === revision)
      signatureByConversation.delete(key);
  }

  async function refresh(source: ChannelTurnSource): Promise<boolean> {
    const key = getConversationKey(source);
    const state = key ? stateByConversation.get(key) : undefined;
    if (
      !key ||
      !state?.isThinkingActive ||
      ownedReplyKey(key) !== getLifecycleReplyKey(source)
    )
      return false;
    const revision = currentRevision(key);
    await writeStatus(source, state.typingFooterText, state.thinkingText, {
      force: true,
    });
    if (
      revisionByConversation.get(key) === revision &&
      state.isThinkingActive
    ) {
      scheduleKeepalive(key);
    }
    return true;
  }

  async function handleLifecycle(
    event: ChannelTurnLifecycleEvent,
  ): Promise<void> {
    if (event.type === "queued") {
      if (await refresh(event.source)) return;
      if (event.source.showStartupStatus) {
        await activate(
          event.source,
          SLACK_ASSISTANT_STARTUP_STATUS,
          SLACK_ASSISTANT_STARTUP_STATUS,
        );
      }
      return;
    }
    for (const source of getUniqueSources(event.sources)) {
      if (event.type === "processing") {
        await clearStale(source);
      } else if (event.stopReason !== "requires_approval") {
        const remaining = event.remainingSources?.some(
          (other) =>
            other.accountId === source.accountId &&
            getConversationKey(other) === getConversationKey(source) &&
            getLifecycleReplyKey(other) === getLifecycleReplyKey(source),
        );
        if (!remaining) await deactivate(source);
      }
    }
  }

  return {
    handleLifecycle,
    getUniqueSources,
    getLifecycleErrorReplyKey,
    activate,
    deactivate,
    clearStale,
    relinquish(source): void {
      const key = getConversationKey(source);
      const replyKey = getLifecycleReplyKey(source);
      if (!key || !replyKey) return;
      const ownsCurrent = ownedReplyKey(key) === replyKey;
      let cutoff = ownsCurrent ? currentRevision(key) : 0;
      for (const write of outstandingWrites.get(key) ?? []) {
        if (write.replyKey === replyKey)
          cutoff = Math.max(cutoff, write.revision);
      }
      if (!cutoff) return;
      const revocationKey = JSON.stringify([key, replyKey]);
      relinquishedThroughRevision.set(
        revocationKey,
        Math.max(relinquishedThroughRevision.get(revocationKey) ?? 0, cutoff),
      );
      // A late relinquish of A may invalidate A's outstanding work, never B's
      // newer active state or keepalive.
      if (ownsCurrent) markAutoClearedByKey(key);
    },
    markAutoCleared(source): void {
      const key = getConversationKey(source);
      if (key && ownedReplyKey(key) === getLifecycleReplyKey(source)) {
        markAutoClearedByKey(key);
      }
    },
    markAutoClearedForMessage(msg): void {
      if (
        isNonEmptyString(msg.agentId) &&
        isNonEmptyString(msg.conversationId)
      ) {
        const key = `${msg.agentId}:${msg.conversationId}`;
        const anchor = firstNonEmptyString(msg.threadId, msg.replyToMessageId);
        // Anchored completion belongs to the thread that was actually posted
        // to. Preserve the existing agent-level behavior for unanchored sends.
        if (
          anchor &&
          ownedReplyKey(key) !==
            `${msg.chatId}:${params.resolveKnownThreadRoot(anchor)}`
        )
          return;
        markAutoClearedByKey(key);
        return;
      }
      const anchor = firstNonEmptyString(msg.threadId, msg.replyToMessageId);
      if (!anchor) return;
      const root = params.resolveKnownThreadRoot(anchor);
      for (const [key, source] of sourceByConversation) {
        if (
          source.chatId === msg.chatId &&
          resolveSlackProgressThreadTs(source) === root
        ) {
          markAutoClearedByKey(key);
        }
      }
    },
    activeSources: () => Array.from(sourceByConversation.values()),
    clear(): void {
      for (const timer of keepaliveByConversation.values()) clearTimeout(timer);
      stateByConversation.clear();
      revisionByConversation.clear();
      sourceByConversation.clear();
      signatureByConversation.clear();
      writePromiseByConversation.clear();
      keepaliveByConversation.clear();
      clearedStaleReplyKeys.clear();
    },
  };
}
