import type {
  ChannelTurnSource,
  OutboundChannelMessage,
} from "@/channels/types";
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

    const signature = `${footerText}\n${loadingText}`;
    if (!options.force && signatureByConversation.get(stateKey) === signature) {
      return true;
    }

    await params.ensureApp();
    const slackClient = await params.ensureWriteClient();
    const setStatus = slackClient.assistant?.threads?.setStatus;
    if (!setStatus) return false;

    signatureByConversation.set(stateKey, signature);
    const previous =
      writePromiseByConversation.get(stateKey) ?? Promise.resolve();
    const operation = previous.then(async () => {
      try {
        await setStatus.call(slackClient.assistant?.threads, {
          channel_id: source.chatId,
          thread_ts: threadTs,
          status: footerText,
          ...(footerText ? { loading_messages: [loadingText] } : {}),
        });
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
    return operation;
  }

  function scheduleKeepalive(key: string): void {
    clearKeepalive(key);
    const timer = setTimeout(() => {
      keepaliveByConversation.delete(key);
      void (async () => {
        const state = stateByConversation.get(key);
        const source = sourceByConversation.get(key);
        if (!state?.isThinkingActive || !source) return;
        await writeStatus(source, state.typingFooterText, state.thinkingText, {
          force: true,
        });
        if (state.isThinkingActive) scheduleKeepalive(key);
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
      state.typingFooterText === footerText
    ) {
      sourceByConversation.set(key, source);
      return;
    }
    state.isThinkingActive = true;
    state.thinkingText = loadingText;
    state.typingFooterText = footerText;
    stateByConversation.set(key, state);
    sourceByConversation.set(key, source);
    const sent = await writeStatus(source, footerText, loadingText);
    if (sent && state.isThinkingActive) scheduleKeepalive(key);
    else if (!sent) state.isThinkingActive = false;
  }

  function markAutoClearedByKey(key: string): void {
    clearKeepalive(key);
    const state = stateByConversation.get(key);
    if (state) state.isThinkingActive = false;
    signatureByConversation.delete(key);
    sourceByConversation.delete(key);
  }

  async function deactivate(source: ChannelTurnSource): Promise<void> {
    const key = getConversationKey(source);
    if (!key) return;
    clearKeepalive(key);
    const state = stateByConversation.get(key);
    if (state) state.isThinkingActive = false;
    signatureByConversation.delete(key);
    sourceByConversation.delete(key);
    await writeStatus(source, "", "", { force: true });
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
    await writeStatus(source, "", "", { force: true });
    signatureByConversation.delete(key);
  }

  return {
    getUniqueSources,
    getLifecycleErrorReplyKey,
    activate,
    deactivate,
    clearStale,
    markAutoCleared(source): void {
      const key = getConversationKey(source);
      if (key) markAutoClearedByKey(key);
    },
    markAutoClearedForMessage(msg): void {
      if (
        isNonEmptyString(msg.agentId) &&
        isNonEmptyString(msg.conversationId)
      ) {
        markAutoClearedByKey(`${msg.agentId}:${msg.conversationId}`);
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
      sourceByConversation.clear();
      signatureByConversation.clear();
      writePromiseByConversation.clear();
      keepaliveByConversation.clear();
      clearedStaleReplyKeys.clear();
    },
  };
}
