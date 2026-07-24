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
const RAPID_DISCONNECT_LIMIT = 5;
const RAPID_DISCONNECT_WINDOW_MS = 60_000;
// A brief open inside a reconnect loop is not stable enough to forgive
// prior disconnects. Clear the loop window only after this much uptime.
const STABLE_OPEN_RESET_MS = RAPID_DISCONNECT_WINDOW_MS;

type EventEmitterLike = {
  on?: (event: string, handler: (payload: unknown) => void) => void;
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
  let stableOpenTimer: ReturnType<typeof setTimeout> | null = null;
  let selfPhoneJid: string | null = null;
  let selfLid: string | null = null;
  let connectedAtMs = 0;
  let connectionGeneration = 0;
  let recentDisconnects: number[] = [];
  let releaseSocketLease: (() => void) | null = null;
  let downloadContentFromMessage:
    | ((message: unknown, type: string) => Promise<AsyncIterable<Uint8Array>>)
    | null = null;
  const sentMessageIds = new Set<string>();
  const seenMessageIds = new Set<string>();
  const lidToJid = new Map<string, string>();
  const messageStore = new Map<string, unknown>();

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

  function clearStableOpenTimer(): void {
    if (!stableOpenTimer) return;
    clearTimeout(stableOpenTimer);
    stableOpenTimer = null;
  }

  function clearActiveSocket(closeWebSocket: boolean): void {
    clearStableOpenTimer();
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

  function clearReconnectTimer(): void {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleStableOpenReset(generation: number): void {
    clearStableOpenTimer();
    const timer = setTimeout(() => {
      if (stableOpenTimer !== timer) return;
      stableOpenTimer = null;
      if (generation !== connectionGeneration || stopping || !running) return;
      reconnectAttempts = 0;
      recentDisconnects = [];
    }, STABLE_OPEN_RESET_MS);
    stableOpenTimer = timer;
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
      if (stopping || !running) return;
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
          scheduleStableOpenReset(generation);
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
            clearReconnectTimer();
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
            (ts) => now - ts <= RAPID_DISCONNECT_WINDOW_MS,
          );
          recentDisconnects.push(now);
          if (recentDisconnects.length > RAPID_DISCONNECT_LIMIT) {
            running = false;
            stopping = true;
            clearReconnectTimer();
            const loopMessage = `WhatsApp disconnected ${recentDisconnects.length} times in ${RAPID_DISCONNECT_WINDOW_MS / 1000}s; stopping to avoid reconnect loop. Another client may be competing for this session. Restart the server to retry.`;
            setWhatsAppConnectionState(account.accountId, {
              status: "error",
              lastError: loopMessage,
            });
            console.warn(`[WhatsApp:${account.accountId}] ${loopMessage}`);
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
      await adapter.onMessage?.(inbound);
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
      clearReconnectTimer();
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
      try {
        await sock?.sendPresenceUpdate?.("composing", targetJid);
      } catch {
        // Presence is best-effort.
      }
      const payload = buildWhatsAppOutboundPayload(msg);
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
      const result = await sendToWhatsApp(
        targetJid,
        { text },
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
      if (!running || event.type !== "finished") return;

      const errorText = event.outcome === "error" ? event.error?.trim() : null;
      if (!errorText) return;

      const uniqueSources = new Map<string, ChannelTurnSource>();
      for (const source of event.sources) {
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
