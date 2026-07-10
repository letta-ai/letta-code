import {
  createInboundDebouncer,
  type InboundDebouncer,
} from "@/channels/inbound-debounce";
import { formatChannelControlRequestPrompt } from "@/channels/interactive";
import { formatChannelLifecycleErrorMessage } from "@/channels/lifecycle-error";
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
  ChannelTurnLifecycleEvent,
  ChannelTurnSource,
  InboundChannelMessage,
  OutboundChannelMessage,
  WhatsAppChannelAccount,
} from "@/channels/types";
import {
  isGroupJid,
  isLidJid,
  isSelfChat,
  isStatusOrBroadcastJid,
  phoneDigitsToJid,
  resolveLidToPhoneJid,
  resolveSendJid,
  senderIdFromJid,
  stripDeviceSuffix,
} from "./jid";
import {
  buildWhatsAppOutboundPayload,
  checkAttachmentPolicy,
  collectWhatsAppAttachments,
  extractMentionedJids,
  extractReplyParticipant,
  extractWhatsAppText,
} from "./media";
import { loadWhatsAppModule } from "./runtime";
import { createWhatsAppSocket, getWhatsAppAuthDir } from "./session";
import { setWhatsAppConnectionState } from "./state";

const CHANNEL_ID = "whatsapp";
const DEDUPE_MAX_SIZE = 5000;
const RECONNECT_MAX_MS = 30_000;
const MAX_MENTION_PATTERN_LENGTH = 256;
const MENTION_MATCH_TEXT_MAX_LENGTH = 2000;
const WHATSAPP_TYPING_REFRESH_MS = 8_000;
const WHATSAPP_TYPING_MAX_MS = 5 * 60 * 1000;

type EventEmitterLike = {
  on?: (event: string, handler: (payload: unknown) => void) => void;
};

type WhatsAppTypingEntry = {
  sourceKeys: Set<string>;
  timer: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout>;
};

type WhatsAppSocket = {
  ev?: EventEmitterLike;
  ws?: { close?: () => void };
  user?: { id?: string; lid?: string };
  signalRepository?: { lidMapping?: Map<string, string> };
  sendMessage?: (
    jid: string,
    payload: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<{ key?: { id?: string }; message?: unknown }>;
  sendPresenceUpdate?: (presence: string, jid?: string) => Promise<void>;
  groupMetadata?: (jid: string) => Promise<{ subject?: string }>;
  chatModify?: (
    modify: Record<string, unknown>,
    jid: string,
  ) => Promise<unknown>;
};

type WhatsAppMessage = {
  key?: {
    remoteJid?: string | null;
    id?: string | null;
    fromMe?: boolean | null;
    participant?: string | null;
    senderPn?: string | null;
  };
  message?: unknown;
  messageTimestamp?: number | { toNumber?: () => number } | null;
  pushName?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function isWhatsAppConflictDisconnect(update: unknown): boolean {
  const record = asRecord(update);
  if (record.connection !== "close") return false;
  const lastDisconnect = asRecord(record.lastDisconnect);
  const error = asRecord(lastDisconnect.error);
  const output = asRecord(error.output);
  const statusCode = output.statusCode;
  const message = typeof error.message === "string" ? error.message : "";
  return (
    statusCode === 440 ||
    /\bconflict\b/i.test(message) ||
    /connection replaced/i.test(message)
  );
}

function timestampToMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value * 1000;
  }
  if (value && typeof value === "object") {
    const toNumber = (value as { toNumber?: () => number }).toNumber;
    if (typeof toNumber === "function") {
      return toNumber.call(value) * 1000;
    }
  }
  return Date.now();
}

function preview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 79)}…`;
}

function getDisplayName(account: WhatsAppChannelAccount): string {
  return account.displayName ?? "WhatsApp";
}

function matchesSelf(
  jid: string,
  selfPhoneJid: string | null,
  selfLid: string | null,
): boolean {
  const normalized = stripDeviceSuffix(jid);
  return (
    (!!selfPhoneJid && normalized === stripDeviceSuffix(selfPhoneJid)) ||
    (!!selfLid && normalized === stripDeviceSuffix(selfLid))
  );
}

function shouldProcessGroup(params: {
  account: WhatsAppChannelAccount;
  groupJid: string;
  text: string;
  mentionedJids: string[];
  replyParticipant: string | null;
  selfPhoneJid: string | null;
  selfLid: string | null;
}): boolean {
  const {
    account,
    groupJid,
    text,
    mentionedJids,
    replyParticipant,
    selfPhoneJid,
    selfLid,
  } = params;
  if (account.groupMode === "disabled") return false;
  if (
    account.allowedGroups?.length &&
    !account.allowedGroups.includes(groupJid)
  ) {
    return false;
  }
  if (account.groupMode === "open") return true;
  if (mentionedJids.some((jid) => matchesSelf(jid, selfPhoneJid, selfLid))) {
    return true;
  }
  if (
    replyParticipant &&
    matchesSelf(replyParticipant, selfPhoneJid, selfLid)
  ) {
    return true;
  }
  const matchText = text.slice(0, MENTION_MATCH_TEXT_MAX_LENGTH);
  for (const pattern of account.mentionPatterns ?? []) {
    if (pattern.length > MAX_MENTION_PATTERN_LENGTH) continue;
    try {
      if (new RegExp(pattern, "i").test(matchText)) return true;
    } catch {
      // Ignore invalid user-provided patterns.
    }
  }
  return false;
}

function buildQuotedOptions(
  targetJid: string,
  replyToMessageId?: string,
): Record<string, unknown> | undefined {
  if (!replyToMessageId) return undefined;
  return {
    quoted: {
      key: { remoteJid: targetJid, id: replyToMessageId },
      message: { conversation: "" },
    },
  };
}

function getLifecycleErrorReplyKey(source: ChannelTurnSource): string | null {
  if (!source.chatId) return null;
  return `${source.chatId}:${source.messageId ?? ""}`;
}

export function createWhatsAppAdapter(
  account: WhatsAppChannelAccount,
): ChannelAdapter {
  let sock: WhatsAppSocket | null = null;
  let running = false;
  let stopping = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let selfPhoneJid: string | null = null;
  let selfLid: string | null = null;
  let connectedAtMs = 0;
  let connectionGeneration = 0;
  let releaseSocketLease: (() => void) | null = null;
  let downloadContentFromMessage:
    | ((message: unknown, type: string) => Promise<AsyncIterable<Uint8Array>>)
    | null = null;
  const sentMessageIds = new Set<string>();
  const seenMessageIds = new Set<string>();
  const lidToJid = new Map<string, string>();
  // Reverse map: phone JID → LID, used so sendPresenceUpdate can target the
  // LID (the protocol-level chat identity) when the conversation is LID-routed.
  // Baileys' sendPresenceUpdate checks `server === 'lid'` on the toJid to
  // decide whether to set `from: me.lid` vs `from: me.id`.  If we pass a phone
  // JID for a conversation that is actually LID-routed, WhatsApp silently drops
  // the presence update.  sendMessage works either way because relayMessage
  // re-encodes the JID internally.
  const jidToLid = new Map<string, string>();
  const messageStore = new Map<string, unknown>();
  const typingByChatId = new Map<string, WhatsAppTypingEntry>();

  // Inbound debouncer: batches back-to-back messages into a single dispatch.
  // Voice notes, attachments, and reactions bypass the debounce (always
  // dispatched immediately). Disabled when inboundDebounceMs is 0/undefined.
  const debouncer: InboundDebouncer<{ inbound: InboundChannelMessage }> =
    createInboundDebouncer<{ inbound: InboundChannelMessage }>({
      debounceMs: Math.max(0, Math.min(account.inboundDebounceMs ?? 0, 10000)),
      buildKey: ({ inbound }) => `${account.accountId}:${inbound.chatId ?? ""}`,
      shouldDebounce: ({ inbound }) => {
        if (inbound.attachments && inbound.attachments.length > 0) return false;
        if (inbound.text && inbound.text.length > 0) return true;
        return false;
      },
      onFlush: async (entries) => {
        const last = entries[entries.length - 1];
        if (!last || !adapter.onMessage) return;
        const combinedText = entries
          .map((e) => (e.inbound.text ?? "").trim())
          .filter(Boolean)
          .join("\n");
        const merged: InboundChannelMessage = {
          ...last.inbound,
          text: combinedText,
        };
        try {
          await adapter.onMessage(merged);
        } catch (err) {
          console.error(
            `[WhatsApp:${account.accountId}] debounced dispatch failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      },
    });

  function rememberSeen(id: string): boolean {
    if (seenMessageIds.has(id)) return true;
    seenMessageIds.add(id);
    if (seenMessageIds.size > DEDUPE_MAX_SIZE) {
      const first = seenMessageIds.values().next().value;
      if (first) seenMessageIds.delete(first);
    }
    return false;
  }

  function rememberSent(id: string, message?: unknown): void {
    if (!id) return;
    sentMessageIds.add(id);
    if (message) messageStore.set(id, message);
    setTimeout(
      () => {
        sentMessageIds.delete(id);
        messageStore.delete(id);
      },
      24 * 60 * 60 * 1000,
    );
  }

  function clearActiveSocket(closeWebSocket: boolean): void {
    const currentSock = sock;
    const releaseLease = releaseSocketLease;
    sock = null;
    releaseSocketLease = null;
    if (closeWebSocket) {
      try {
        currentSock?.ws?.close?.();
      } catch {
        // Best effort. Do not logout; logout invalidates the linked device.
      }
    }
    releaseLease?.();
  }

  async function ensureRuntimeHelpers(): Promise<void> {
    if (downloadContentFromMessage) return;
    const mod = await loadWhatsAppModule();
    const helper = mod.downloadContentFromMessage;
    if (typeof helper === "function") {
      downloadContentFromMessage = helper as unknown as NonNullable<
        typeof downloadContentFromMessage
      >;
    }
  }

  function scheduleReconnect(reason?: string): void {
    if (stopping || !running || reconnectTimer) return;
    reconnectAttempts += 1;
    const delay = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** reconnectAttempts);
    console.warn(
      `[WhatsApp:${account.accountId}] disconnected${reason ? ` (${reason})` : ""}; reconnecting in ${Math.round(delay / 1000)}s.`,
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setWhatsAppConnectionState(account.accountId, {
          status: "error",
          lastError: message,
        });
        scheduleReconnect(message);
      });
    }, delay);
  }

  async function connect(): Promise<void> {
    connectionGeneration += 1;
    const generation = connectionGeneration;
    clearActiveSocket(true);
    await ensureRuntimeHelpers();
    connectedAtMs = Date.now();
    const result = await createWhatsAppSocket({
      accountId: account.accountId,
      printQr: true,
      messageStore,
      onConnectionUpdate(update) {
        if (generation !== connectionGeneration) return;
        if (update.connection === "open") {
          reconnectAttempts = 0;
          selfPhoneJid = stripDeviceSuffix(sock?.user?.id ?? null) || null;
          selfLid = stripDeviceSuffix(sock?.user?.lid ?? null) || null;
          const mode = account.selfChatMode
            ? "self-chat mode (only your own Message Yourself chat routes)"
            : "open identity mode (replies appear under the linked WhatsApp number)";
          console.log(
            `[WhatsApp:${account.accountId}] Connected as ${selfPhoneJid ?? "unknown"}; ${mode}.`,
          );
        }
        if (update.connection === "close" && !stopping) {
          clearActiveSocket(false);
          const lastDisconnect = asRecord(update.lastDisconnect);
          const error = asRecord(lastDisconnect.error);
          if (isWhatsAppConflictDisconnect(update)) {
            running = false;
            stopping = true;
            const message =
              typeof error.message === "string"
                ? error.message
                : "WhatsApp session conflict";
            setWhatsAppConnectionState(account.accountId, {
              status: "error",
              lastError: `${message}. Another WhatsApp client is using this linked-device session; not reconnecting automatically.`,
            });
            console.warn(
              `[WhatsApp:${account.accountId}] disconnected due to session conflict; not reconnecting automatically. Stop any other WhatsApp server using this account/auth session, then restart this server.`,
            );
            return;
          }
          scheduleReconnect(
            typeof error.message === "string" ? error.message : undefined,
          );
        }
      },
    });
    if (generation !== connectionGeneration || stopping || !running) {
      try {
        (result.sock as WhatsAppSocket).ws?.close?.();
      } catch {
        // Best effort; release below is the important part.
      }
      result.release();
      return;
    }
    sock = result.sock as WhatsAppSocket;
    releaseSocketLease = result.release;
    sock.ev?.on?.("messages.upsert", (event) => {
      void handleMessagesUpsert(event).catch((error) => {
        console.error(
          `[WhatsApp:${account.accountId}] inbound handler failed:`,
          error instanceof Error ? error.message : error,
        );
      });
    });
  }

  function resolveInboundChatId(
    remoteJid: string,
    selfChat: boolean,
    msg: WhatsAppMessage,
  ): string {
    const normalizedRemote = stripDeviceSuffix(remoteJid);
    if (selfChat) {
      if (selfPhoneJid) return selfPhoneJid;
      const digits = senderIdFromJid(remoteJid);
      return phoneDigitsToJid(digits) || normalizedRemote;
    }
    if (isLidJid(normalizedRemote)) {
      const resolved = resolveLidToPhoneJid({
        lidJid: normalizedRemote,
        message: msg,
        sock,
      });
      if (resolved) {
        lidToJid.set(normalizedRemote, resolved);
        jidToLid.set(resolved, normalizedRemote);
        return resolved;
      }
    }
    return normalizedRemote;
  }

  async function getGroupLabel(groupJid: string): Promise<string | undefined> {
    try {
      return (await sock?.groupMetadata?.(groupJid))?.subject;
    } catch {
      return undefined;
    }
  }

  // ── Typing indicator loop ───────────────────────────────────────
  // Mirrors the Telegram/Discord typing pattern: per-chat entry with
  // source-key refcount, refresh interval, and max-lifetime timeout.
  // Only active when waitingBehavior === "typing_indicator".

  function getTypingSourceKey(source: ChannelTurnSource): string | null {
    if (source.channel !== CHANNEL_ID) return null;
    const chatId = source.chatId;
    if (!chatId) return null;
    return [
      source.accountId ?? "",
      chatId,
      source.messageId ?? "",
      source.agentId,
      source.conversationId,
    ].join(":");
  }

  function resolveTypingPresenceJid(chatId: string): string {
    const targetJid = resolveSendJid({
      chatId,
      selfPhoneJid,
      selfLid,
      lidToJid,
      sock,
    });
    return resolvePresenceJid(targetJid, jidToLid);
  }

  async function sendTypingPresence(chatId: string): Promise<void> {
    if (!running) return;
    try {
      const presenceJid = resolveTypingPresenceJid(chatId);
      await sock?.sendPresenceUpdate?.("composing", presenceJid);
    } catch {
      // Best-effort; presence failures are non-fatal.
    }
  }

  function startTypingForSource(source: ChannelTurnSource): void {
    const chatId = source.chatId;
    const sourceKey = getTypingSourceKey(source);
    if (!chatId || !sourceKey) return;

    const existing = typingByChatId.get(chatId);
    if (existing) {
      existing.sourceKeys.add(sourceKey);
      return;
    }

    void sendTypingPresence(chatId);
    const timer = setInterval(() => {
      void sendTypingPresence(chatId);
    }, WHATSAPP_TYPING_REFRESH_MS);
    const timeout = setTimeout(() => {
      clearTypingForChat(chatId);
    }, WHATSAPP_TYPING_MAX_MS);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref?: () => void }).unref?.();
    }
    if (typeof (timeout as { unref?: () => void }).unref === "function") {
      (timeout as { unref?: () => void }).unref?.();
    }
    typingByChatId.set(chatId, {
      sourceKeys: new Set([sourceKey]),
      timer,
      timeout,
    });
  }

  function stopTypingForSource(source: ChannelTurnSource): void {
    const chatId = source.chatId;
    const sourceKey = getTypingSourceKey(source);
    if (!chatId || !sourceKey) return;

    const entry = typingByChatId.get(chatId);
    if (!entry) return;
    entry.sourceKeys.delete(sourceKey);
    if (entry.sourceKeys.size === 0) {
      clearTypingForChat(chatId);
    }
  }

  function clearTypingForChat(chatId: string): void {
    const entry = typingByChatId.get(chatId);
    if (!entry) return;
    clearInterval(entry.timer);
    clearTimeout(entry.timeout);
    typingByChatId.delete(chatId);
  }

  function clearAllTyping(): void {
    for (const entry of typingByChatId.values()) {
      clearInterval(entry.timer);
      clearTimeout(entry.timeout);
    }
    typingByChatId.clear();
  }

  async function stopTypingPresence(chatId: string): Promise<void> {
    try {
      const presenceJid = resolveTypingPresenceJid(chatId);
      await sock?.sendPresenceUpdate?.("paused", presenceJid);
    } catch {
      // Best-effort.
    }
  }

  async function handleMessagesUpsert(event: unknown): Promise<void> {
    const record = asRecord(event);
    if (record.type !== "notify" && record.type !== "append") return;
    const messages = Array.isArray(record.messages)
      ? (record.messages as WhatsAppMessage[])
      : [];
    const isHistory = record.type === "append";
    for (const msg of messages) {
      const remoteJid = msg.key?.remoteJid ?? "";
      const messageId = msg.key?.id ?? "";
      if (!remoteJid || !messageId || !msg.message) continue;
      if (isStatusOrBroadcastJid(remoteJid)) continue;
      if (sentMessageIds.has(messageId)) {
        sentMessageIds.delete(messageId);
        continue;
      }
      if (!messageStore.has(messageId)) {
        messageStore.set(messageId, msg);
        setTimeout(() => messageStore.delete(messageId), 24 * 60 * 60 * 1000);
      }

      // Mark inbound messages as read immediately (fire-and-forget, best-effort).
      // Skip fromMe — no need to mark our own sent messages.
      // Baileys requires messageTimestamp in lastMessages; missing it throws
      // synchronously inside chat-utils.js before the .catch can attach, so we
      // wrap in try/catch defensively.
      if (msg.key?.fromMe !== true) {
        try {
          void sock
            ?.chatModify?.(
              {
                markRead: true,
                lastMessages: [
                  { key: msg.key, messageTimestamp: msg.messageTimestamp },
                ],
              },
              msg.key?.remoteJid ?? remoteJid,
            )
            .catch((err) =>
              console.warn(
                `[WhatsApp:${account.accountId}] markRead failed:`,
                err instanceof Error ? err.message : err,
              ),
            );
        } catch (err) {
          console.warn(
            `[WhatsApp:${account.accountId}] markRead sync throw:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      const selfChat = isSelfChat(remoteJid, selfPhoneJid, selfLid);
      const fromMe = msg.key?.fromMe === true;
      if (fromMe && !(account.selfChatMode && selfChat)) continue;
      if (account.selfChatMode && !selfChat) {
        console.log(
          `[WhatsApp:${account.accountId}] drop non-self message in self-chat mode remoteJid=${remoteJid}`,
        );
        continue;
      }

      const timestamp = timestampToMs(msg.messageTimestamp);
      if (isHistory || timestamp < connectedAtMs - 1000) continue;

      const group = isGroupJid(remoteJid);
      const chatId = group
        ? stripDeviceSuffix(remoteJid)
        : resolveInboundChatId(remoteJid, selfChat, msg);
      if (rememberSeen(`${chatId}:${messageId}`)) continue;

      const text = extractWhatsAppText(msg.message);
      const attachmentResult = await collectWhatsAppAttachments({
        accountId: account.accountId,
        chatId,
        messageId,
        message: msg.message,
        downloadContentFromMessage: downloadContentFromMessage ?? undefined,
        downloadMedia: account.downloadMedia === true,
        mediaMaxBytes: account.mediaMaxBytes,
        transcribeVoice: account.transcribeVoice === true,
      });
      const body = attachmentResult.transcriptionText || text;
      if (!body.trim() && attachmentResult.attachments.length === 0) continue;

      const senderJid = group
        ? (msg.key?.participant ?? msg.key?.senderPn ?? remoteJid)
        : chatId;
      const senderId = selfChat
        ? senderIdFromJid(selfPhoneJid ?? chatId)
        : senderIdFromJid(senderJid);

      const mentionedJids = extractMentionedJids(msg.message);
      const replyParticipant = extractReplyParticipant(msg.message);
      const groupAllowed = !group
        ? true
        : shouldProcessGroup({
            account,
            groupJid: chatId,
            text: body,
            mentionedJids,
            replyParticipant,
            selfPhoneJid,
            selfLid,
          });
      if (!groupAllowed) continue;

      const chatLabel = group
        ? await getGroupLabel(chatId)
        : selfChat
          ? "Self (WhatsApp)"
          : msg.pushName?.trim() || senderId;

      const inbound: InboundChannelMessage = {
        channel: CHANNEL_ID,
        accountId: account.accountId,
        chatId,
        senderId,
        senderName: msg.pushName?.trim() || senderId,
        chatLabel,
        text: body,
        timestamp,
        messageId,
        chatType: group ? "channel" : "direct",
        isMention: group ? account.groupMode !== "open" : true,
        attachments:
          attachmentResult.attachments.length > 0
            ? attachmentResult.attachments
            : undefined,
        raw: msg,
      };

      console.log(
        `[WhatsApp:${account.accountId}] inbound chatId=${chatId} sender=${senderId} text="${preview(body)}"`,
      );
      await debouncer.enqueue({ inbound });
    }
  }

  async function sendToWhatsApp(
    chatId: string,
    payload: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ key?: { id?: string }; message?: unknown }> {
    if (!sock?.sendMessage) throw new Error("WhatsApp adapter is not running.");
    const targetJid = resolveSendJid({
      chatId,
      selfPhoneJid,
      selfLid,
      lidToJid,
      sock,
    });
    return await sock.sendMessage(targetJid, payload, options);
  }

  const adapter: ChannelAdapter = {
    id: `${CHANNEL_ID}:${account.accountId}`,
    channelId: CHANNEL_ID,
    accountId: account.accountId,
    name: getDisplayName(account),

    async start() {
      if (running) return;
      running = true;
      stopping = false;
      await connect();
      console.log(`[WhatsApp:${account.accountId}] Adapter started.`);
    },

    async stop() {
      if (!running) return;
      stopping = true;
      running = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearAllTyping();
      connectionGeneration += 1;
      clearActiveSocket(true);
      setWhatsAppConnectionState(account.accountId, { status: "disconnected" });
    },

    isRunning() {
      return running;
    },

    async sendMessage(msg: OutboundChannelMessage) {
      if (!running) throw new Error("WhatsApp adapter is not running.");
      if (!msg.text?.trim() && !msg.mediaPath?.trim() && !msg.reaction) {
        throw new Error("WhatsApp send requires message or media.");
      }
      // Stop typing immediately before sending the reply. The refresh
      // interval can otherwise fire a final "composing" presence between
      // the reply landing and the "finished" lifecycle event arriving,
      // causing a brief typing blip after the answer.
      if (msg.chatId && typingByChatId.has(msg.chatId)) {
        clearTypingForChat(msg.chatId);
        void stopTypingPresence(msg.chatId);
      }
      const targetJid = resolveSendJid({
        chatId: msg.chatId,
        selfPhoneJid,
        selfLid,
        lidToJid,
        sock,
      });
      if (msg.reaction || msg.removeReaction) {
        const target = msg.targetMessageId ?? msg.replyToMessageId;
        if (!target) throw new Error("WhatsApp reactions require messageId.");
        const result = await sendToWhatsApp(targetJid, {
          react: {
            text: msg.removeReaction ? "" : (msg.reaction ?? ""),
            key: { remoteJid: targetJid, id: target },
          },
        });
        const id = result.key?.id ?? target;
        rememberSent(id, result);
        return { messageId: id };
      }
      if (
        account.messagePrefix &&
        msg.text?.trim() &&
        !msg.reaction &&
        !msg.removeReaction
      ) {
        msg = { ...msg, text: account.messagePrefix + msg.text };
      }
      const payload = buildWhatsAppOutboundPayload(msg, {
        audioAsVoiceMemo: account.audioAsVoiceMemo,
      });
      // Enforce attachment policy for outbound media sends
      if (msg.mediaPath) {
        const policyError = checkAttachmentPolicy({
          policy: {
            attachmentFilter: account.attachmentFilter !== false,
            attachmentMimeTypes: account.attachmentMimeTypes ?? [],
            attachmentAllowedRecipients:
              account.attachmentAllowedRecipients ?? [],
            attachmentAllowedPaths: account.attachmentAllowedPaths ?? [],
            attachmentPathRecursive: account.attachmentPathRecursive === true,
          },
          mediaPath: msg.mediaPath,
          recipientChatId: msg.chatId,
        });
        if (policyError) throw new Error(policyError);
      }
      const result = await sendToWhatsApp(
        targetJid,
        payload,
        buildQuotedOptions(targetJid, msg.replyToMessageId),
      );
      const id = result.key?.id ?? "";
      rememberSent(id, result);
      return { messageId: id };
    },

    async sendDirectReply(chatId, text, options) {
      if (!running || !text.trim()) return;
      const targetJid = resolveSendJid({
        chatId,
        selfPhoneJid,
        selfLid,
        lidToJid,
        sock,
      });
      const prefixed = account.messagePrefix
        ? account.messagePrefix + text
        : text;
      const result = await sendToWhatsApp(
        targetJid,
        { text: prefixed },
        buildQuotedOptions(targetJid, options?.replyToMessageId),
      );
      rememberSent(result.key?.id ?? "", result);
    },

    async handleControlRequestEvent(event: ChannelControlRequestEvent) {
      // Never post approval/control prompts into groups. Direct/self-chat
      // routes may use the normal text approval flow.
      if (event.source.chatType === "channel") return;
      await adapter.sendDirectReply(
        event.source.chatId,
        formatChannelControlRequestPrompt(event),
        { replyToMessageId: event.source.messageId },
      );
    },

    async handleTurnLifecycleEvent(
      event: ChannelTurnLifecycleEvent,
    ): Promise<void> {
      if (!running) return;

      // "processing" = the agent turn has actually started. Start typing.
      if (event.type === "processing") {
        if (account.waitingBehavior !== "typing_indicator") return;
        for (const source of event.sources) {
          startTypingForSource(source);
        }
        return;
      }

      // "queued" = waiting for prior turns to finish; no typing yet.
      if (event.type === "queued") return;

      // "finished" = stop typing for all sources, then handle error replies.
      const finishedSources = event.sources;
      const chatsToStopPresence = new Set<string>();
      for (const source of finishedSources) {
        const wasActive = typingByChatId.has(source.chatId);
        stopTypingForSource(source);
        if (wasActive && !typingByChatId.has(source.chatId)) {
          chatsToStopPresence.add(source.chatId);
        }
      }
      // Best-effort: send "paused" presence to clear the typing indicator.
      await Promise.all(
        Array.from(chatsToStopPresence).map((chatId) =>
          stopTypingPresence(chatId),
        ),
      );

      const errorText = event.outcome === "error" ? event.error?.trim() : null;
      if (!errorText) return;

      const uniqueSources = new Map<string, ChannelTurnSource>();
      for (const source of finishedSources) {
        const key = getLifecycleErrorReplyKey(source);
        if (!key || uniqueSources.has(key)) continue;
        uniqueSources.set(key, source);
      }

      await Promise.all(
        Array.from(uniqueSources.values()).map(async (source) => {
          try {
            await adapter.sendDirectReply(
              source.chatId,
              formatChannelLifecycleErrorMessage(errorText, {
                runId: event.runId,
              }),
              { replyToMessageId: source.messageId },
            );
          } catch (error) {
            console.warn(
              `[WhatsApp:${account.accountId}] Failed to send lifecycle error reply for ${source.chatId}:`,
              error instanceof Error ? error.message : error,
            );
          }
        }),
      );
    },
  };

  return adapter;
}

export function resolveWhatsAppAccountDisplayName(
  account: WhatsAppChannelAccount,
): string | undefined {
  return (
    account.displayName ??
    (account.selfChatMode ? "WhatsApp (self-chat)" : "WhatsApp")
  );
}

export function getWhatsAppAuthPath(accountId: string): string {
  return getWhatsAppAuthDir(accountId);
}

/**
 * Given a resolved (phone) target JID and a reverse LID map, return the JID
 * to use for sendPresenceUpdate.
 *
 * For LID-routed conversations, the chat-state subscription lives on the LID.
 * Passing the phone JID to Baileys' sendPresenceUpdate causes WhatsApp to
 * silently drop the presence update because it sets `from: me.id` (phone)
 * instead of `from: me.lid`, and the server can't match the chat state.
 *
 * If a LID exists in the reverse map for this phone JID, prefer it.
 * Otherwise fall back to the phone JID (non-LID conversations work fine).
 */
export function resolvePresenceJid(
  targetJid: string,
  jidToLid: Map<string, string>,
): string {
  return jidToLid.get(targetJid) ?? targetJid;
}
