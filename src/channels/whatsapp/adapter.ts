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
import { resolveInboundChatId } from "./inbound-identity";
import {
  isGroupJid,
  isSelfChat,
  isStatusOrBroadcastJid,
  resolvePresenceJid,
  resolveSendJid,
  senderIdFromJid,
  stripDeviceSuffix,
} from "./jid";
import { LidDesk } from "./lid-desk";
import {
  buildWhatsAppOutboundPayload,
  checkAttachmentPolicy,
  collectWhatsAppAttachments,
  extractMentionedJids,
  extractReplyParticipant,
  extractWhatsAppText,
} from "./media";
import { normalizeMessageKey } from "./message-key";
import { loadWhatsAppModule } from "./runtime";
import { createWhatsAppSocket, getWhatsAppAuthDir } from "./session";
import { setWhatsAppConnectionState } from "./state";

const CHANNEL_ID = "whatsapp";
const DEDUPE_MAX_SIZE = 5000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Guardrail: if the socket disconnects this many times within the window,
 * we stop reconnecting and mark the account as errored. This catches
 * session-conflict loops (another WhatsApp client competing for the same
 * linked-device session) instead of bouncing forever.
 */
const RAPID_DISCONNECT_LIMIT = 5;
const RAPID_DISCONNECT_WINDOW_MS = 60_000;
const MAX_MENTION_PATTERN_LENGTH = 256;
const MENTION_MATCH_TEXT_MAX_LENGTH = 2000;
const WHATSAPP_TYPING_REFRESH_MS = 12_000;
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
  onWhatsApp?: (
    phoneNumber: string,
  ) => Promise<
    { exists?: boolean; jid?: string; lid?: string }[] | undefined | null
  >;
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
  let recentDisconnects: number[] = [];
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

  // ── LidDesk: persistent PN↔LID mapping store ─────────────────────
  // Replaces the ephemeral lidToJid/jidToLid Maps. Persists to JSON in the
  // account auth dir so mappings survive container restarts. The desk is
  // mined from inbound messages (senderPn, participant) and from
  // sock.signalRepository.lidMapping on connect.
  const authDir = getWhatsAppAuthDir(account.accountId);
  const lidDesk = new LidDesk(authDir);
  lidDesk.load();
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
          recentDisconnects = [];
          selfPhoneJid = stripDeviceSuffix(sock?.user?.id ?? null) || null;
          selfLid = stripDeviceSuffix(sock?.user?.lid ?? null) || null;
          // Mine PN↔LID mappings from the Baileys signal repository.
          // This is a read-only operation on the socket.
          const mined = lidDesk.mineFromSocket(sock);
          if (mined > 0) lidDesk.save();
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
          // Guardrail: detect rapid disconnect loops (e.g. session conflict
          // that doesn't trigger the explicit conflict-disconnect path).
          const now = Date.now();
          recentDisconnects = recentDisconnects.filter(
            (ts) => now - ts < RAPID_DISCONNECT_WINDOW_MS,
          );
          recentDisconnects.push(now);
          if (recentDisconnects.length > RAPID_DISCONNECT_LIMIT) {
            running = false;
            stopping = true;
            const loopMessage = `WhatsApp disconnected ${recentDisconnects.length} times in ${RAPID_DISCONNECT_WINDOW_MS / 1000}s; stopping to avoid reconnect loop. Another client may be competing for this session. Restart the server to retry.`;
            setWhatsAppConnectionState(account.accountId, {
              status: "error",
              lastError: loopMessage,
            });
            console.warn(
              `[WhatsApp:${account.accountId}] ${loopMessage}`,
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

  /**
   * Sync, cache-only presence JID resolution. Used for the initial composing
   * presence so it fires synchronously within the lifecycle event handler.
   * Never calls onWhatsApp — that's the async refresh path's job.
   */
  function resolveTypingPresenceJidSync(chatId: string): string {
    const lidToJid = lidDesk.getLidToJidMap();
    const jidToLid = lidDesk.getJidToLidMap();
    const targetJid = resolveSendJid({
      chatId,
      selfPhoneJid,
      selfLid,
      lidToJid,
      sock,
    });
    return resolvePresenceJid({ targetJid, jidToLid });
  }

  /**
   * Async presence JID resolution with on-demand LID lookup via onWhatsApp.
   * Used by the interval refresh path: the lookup result updates the cached
   * LID so the *next* tick uses it. Does NOT delay the initial composing.
   */
  async function resolveTypingPresenceJidWithLookup(
    chatId: string,
  ): Promise<string> {
    const jidToLid = lidDesk.getJidToLidMap();
    // Sync resolution first (same as resolveTypingPresenceJidSync).
    const syncJid = resolveTypingPresenceJidSync(chatId);
    // If we already have a LID in the cache, no need for onWhatsApp.
    if (jidToLid.has(syncJid)) return syncJid;
    // Otherwise, try on-demand lookup (rate-limited inside LidDesk).
    const lid = await lidDesk.lookupLidForPhone(syncJid, sock);
    if (lid) return lid;
    return syncJid;
  }

  function sendTypingPresenceSync(chatId: string): void {
    if (!running) return;
    try {
      const presenceJid = resolveTypingPresenceJidSync(chatId);
      void sock?.sendPresenceUpdate?.("composing", presenceJid);
    } catch {
      // Best-effort; presence failures are non-fatal.
    }
  }

  async function sendTypingPresenceAsync(chatId: string): Promise<void> {
    if (!running) return;
    try {
      const presenceJid = await resolveTypingPresenceJidWithLookup(chatId);
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

    sendTypingPresenceSync(chatId);
    const timer = setInterval(() => {
      void sendTypingPresenceAsync(chatId);
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

  function stopTypingPresence(chatId: string): void {
    try {
      const presenceJid = resolveTypingPresenceJidSync(chatId);
      void sock?.sendPresenceUpdate?.("paused", presenceJid);
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
      const key = normalizeMessageKey(msg.key);
      const remoteJid = key.remoteJid ?? "";
      const messageId = key.id ?? "";
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
      if (key.fromMe !== true) {
        try {
          void sock
            ?.chatModify?.(
              {
                markRead: true,
                lastMessages: [
                  { key: key.raw, messageTimestamp: msg.messageTimestamp },
                ],
              },
              key.remoteJid ?? remoteJid,
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

      // Mine PN↔LID mappings from every inbound message (including groups
      // and history) before any filtering. This ensures we capture mappings
      // even from messages we don't ultimately route.
      if (lidDesk.mineFromMessage(msg)) {
        lidDesk.save();
      }

      const selfChat = isSelfChat(remoteJid, selfPhoneJid, selfLid);
      const fromMe = key.fromMe === true;
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
        : resolveInboundChatId(
            { sock, selfPhoneJid, lidDesk },
            remoteJid,
            selfChat,
            msg,
          );
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
        ? (key.participant ?? key.senderPn ?? remoteJid)
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
      lidToJid: lidDesk.getLidToJidMap(),
      sock,
    });
    return await sock.sendMessage(targetJid, payload, options);
  }

  const adapter: ChannelAdapter & {
    getLidDesk?: () => LidDesk;
    getSocket?: () => WhatsAppSocket | null;
  } = {
    id: `${CHANNEL_ID}:${account.accountId}`,
    channelId: CHANNEL_ID,
    accountId: account.accountId,
    name: getDisplayName(account),

    /** @internal Expose LidDesk for outbound route bootstrap. */
    getLidDesk: () => lidDesk,

    /** @internal Expose current socket for outbound route bootstrap. */
    getSocket: () => sock,

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
        stopTypingPresence(msg.chatId);
      }
      const targetJid = resolveSendJid({
        chatId: msg.chatId,
        selfPhoneJid,
        selfLid,
        lidToJid: lidDesk.getLidToJidMap(),
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
      const payload = buildWhatsAppOutboundPayload(msg);
      // Enforce attachment policy for outbound media sends
      if (msg.mediaPath) {
        const policyError = checkAttachmentPolicy({
          policy: {
            attachmentFilter: account.attachmentFilter === true,
            attachmentMimeTypes: account.attachmentMimeTypes ?? [],
            attachmentAllowedRecipients:
              account.attachmentAllowedRecipients ?? [],
            attachmentAllowedPaths: account.attachmentAllowedPaths ?? [],
            attachmentPathRecursive: account.attachmentPathRecursive === true,
          },
          mediaPath: msg.mediaPath,
          recipientChatId: msg.chatId,
          lidDesk,
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
        lidToJid: lidDesk.getLidToJidMap(),
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
      for (const chatId of chatsToStopPresence) {
        stopTypingPresence(chatId);
      }

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
 * to use for sendPresenceUpdate. See ./jid.ts for the canonical implementation;
 * this is re-exported here only for backward compatibility with prior callers.
 */
export { resolvePresenceJid } from "./jid";
