import { join } from "node:path";
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
  asRecord,
  buildWhatsAppQuotedOptions,
  getWhatsAppDisplayName,
  getWhatsAppLifecycleErrorReplyKey,
  isWhatsAppConflictDisconnect,
  isWhatsAppReactionMessage,
  previewWhatsAppText,
  shouldProcessWhatsAppGroup,
  timestampToMs,
  withWhatsAppPayloadMessagePrefix,
} from "./adapter-helpers";
import type {
  WhatsAppMessage,
  WhatsAppMessageKey,
  WhatsAppSocket,
} from "./adapter-types";
import { decideWhatsAppAttachmentPolicy } from "./attachment-policy";
import { createWhatsAppDedupeClaims } from "./dedupe-claims";
import { resolveInboundIdentity } from "./identity";
import {
  createWhatsAppInboundDebounceController,
  type WhatsAppInboundDebounceController,
  type WhatsAppInboundDebounceEntry,
} from "./inbound-debounce";
import {
  isGroupJid,
  isSelfChat,
  isStatusOrBroadcastJid,
  isStrictPhoneJid,
  resolveSendJid,
  senderIdFromJid,
  stripDeviceSuffix,
} from "./jid";
import type { LidStore } from "./lid-store";
import { createLidStore } from "./lid-store";
import {
  buildWhatsAppOutboundPayload,
  collectWhatsAppAttachments,
  extractMentionedJids,
  extractReplyParticipant,
  extractWhatsAppText,
  type WhatsAppResolvedOutboundMedia,
} from "./media";
import { createWhatsAppMessageStore } from "./message-store";
import {
  isWhatsAppReactionGroupEligible,
  parseWhatsAppReactionEntry,
  type WhatsAppReaction,
} from "./reactions";
import {
  createDefaultWhatsAppReconnectScheduler,
  type WhatsAppReconnectScheduler,
  type WhatsAppReconnectTimer,
} from "./reconnect-scheduler";
import { loadWhatsAppModule } from "./runtime";
import { createWhatsAppSocket, getWhatsAppAuthDir } from "./session";
import { setWhatsAppConnectionState } from "./state";
import {
  createWhatsAppTypingController,
  type WhatsAppTypingController,
  type WhatsAppTypingPresence,
} from "./typing-controller";

export { isWhatsAppConflictDisconnect };
export type { WhatsAppReconnectScheduler };

const CHANNEL_ID = "whatsapp";
const DEDUPE_MAX_SIZE = 5000;
const RECONNECT_MAX_MS = 30_000;
const MAX_UNSTABLE_DISCONNECTS = 6;
const RECONNECT_WINDOW_MS = 60_000;
const STABLE_OPEN_RESET_MS = RECONNECT_WINDOW_MS;

export type WhatsAppAdapterDependencies = {
  createSocket?: typeof createWhatsAppSocket;
  loadRuntimeModule?: typeof loadWhatsAppModule;
  lidStore?: LidStore;
  reconnectScheduler?: WhatsAppReconnectScheduler;
};

const CLAIM_CONNECTION_STATE = { claimedConnectionState: true } as const;
export function createWhatsAppAdapter(
  account: WhatsAppChannelAccount,
  dependencies: WhatsAppAdapterDependencies = {},
): ChannelAdapter {
  let sock: WhatsAppSocket | null = null;
  let running = false;
  let stopping = false;
  let reconnectAttempts = 0;
  let reconnectTimer: WhatsAppReconnectTimer | null = null;
  let stableOpenTimer: WhatsAppReconnectTimer | null = null;
  let selfPhoneJid: string | null = null;
  let selfLid: string | null = null;
  let connectedAtMs = 0;
  let connectionGeneration = 0;
  const recentDisconnects: number[] = [];
  let closedGeneration: number | null = null;
  const reconnectScheduler =
    dependencies.reconnectScheduler ??
    createDefaultWhatsAppReconnectScheduler();
  let releaseSocketLease: (() => void) | null = null;
  let typing!: WhatsAppTypingController<WhatsAppSocket>;
  let downloadContentFromMessage:
    | ((message: unknown, type: string) => Promise<AsyncIterable<Uint8Array>>)
    | null = null;
  const dedupeClaims = createWhatsAppDedupeClaims(DEDUPE_MAX_SIZE);
  const lidStore =
    dependencies.lidStore ??
    createLidStore(
      join(getWhatsAppAuthDir(account.accountId), "lid-mappings.json"),
    );
  let lidStoreDirty = false;
  const outboundMessages = createWhatsAppMessageStore(canonicalizeChatId);
  const { messages: messageStore } = outboundMessages;
  let inboundDebounce: WhatsAppInboundDebounceController<
    WhatsAppSocket,
    WhatsAppMessageKey
  > | null = null;

  function flushLidStoreIfDirty(): void {
    if (!lidStoreDirty) return;
    try {
      lidStore.flush();
      lidStoreDirty = false;
    } catch {
      console.warn(
        `[WhatsApp:${account.accountId}] failed to flush LID mappings; will retry.`,
      );
    }
  }

  function applyObservedMappings(
    mappings: Array<{ lidJid: string; phoneJid: string }>,
  ): boolean {
    for (const mapping of mappings) {
      const result = lidStore.record(mapping.lidJid, mapping.phoneJid);
      if (!result || result.status === "conflict") return false;
      if (result.status === "recorded") lidStoreDirty = true;
    }
    return true;
  }

  function clearActiveSocket(closeWebSocket: boolean): void {
    clearStableOpenTimer();
    const currentSock = sock;
    const releaseLease = releaseSocketLease;
    inboundDebounce?.cancelPending();
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

  function clearWhatsAppReconnectTimer(): void {
    const timer = reconnectTimer;
    reconnectTimer = null;
    timer?.task?.cancel();
  }

  function clearStableOpenTimer(): void {
    const timer = stableOpenTimer;
    stableOpenTimer = null;
    timer?.task?.cancel();
  }

  function scheduleStableOpenReset(generation: number): void {
    clearStableOpenTimer();
    const timer: WhatsAppReconnectTimer = {
      generation,
      task: null,
    };
    stableOpenTimer = timer;
    timer.task = reconnectScheduler.schedule(
      STABLE_OPEN_RESET_MS,
      () => {
        if (stableOpenTimer !== timer) return;
        stableOpenTimer = null;
        if (timer.generation !== connectionGeneration || stopping || !running) {
          return;
        }
        reconnectAttempts = 0;
        recentDisconnects.length = 0;
      },
      { unref: true },
    );
  }

  async function ensureRuntimeHelpers(): Promise<void> {
    if (downloadContentFromMessage) return;
    const mod = await (dependencies.loadRuntimeModule ?? loadWhatsAppModule)();
    const helper = mod.downloadContentFromMessage;
    if (typeof helper === "function") {
      downloadContentFromMessage = helper as unknown as NonNullable<
        typeof downloadContentFromMessage
      >;
    }
  }

  function canonicalizeChatId(chatId: string): string | null {
    try {
      return resolveSendJid({
        chatId,
        selfPhoneJid,
        selfLid,
        resolveLid: (lidJid) => lidStore.resolve(lidJid),
      });
    } catch {
      return null;
    }
  }

  function getTypingOwner(): WhatsAppSocket | null {
    return sock;
  }

  function sendTypingPresence(
    owner: WhatsAppSocket,
    chatId: string,
    presence: WhatsAppTypingPresence,
  ): unknown {
    return owner.sendPresenceUpdate?.(presence, chatId);
  }

  function scheduleReconnect(reason?: string): void {
    if (stopping || !running || reconnectTimer) return;
    reconnectAttempts += 1;
    const delay = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** reconnectAttempts);
    const generation = connectionGeneration;
    const timer: WhatsAppReconnectTimer = {
      generation,
      task: null,
    };
    console.warn(
      `[WhatsApp:${account.accountId}] disconnected${reason ? ` (${reason})` : ""}; reconnecting in ${Math.round(delay / 1000)}s.`,
    );
    reconnectTimer = timer;
    timer.task = reconnectScheduler.schedule(
      delay,
      () => {
        if (reconnectTimer !== timer) return;
        reconnectTimer = null;
        if (timer.generation !== connectionGeneration || stopping || !running) {
          return;
        }
        const reconnectGeneration = connectionGeneration + 1;
        void connect().catch((error) => {
          if (
            reconnectGeneration !== connectionGeneration ||
            stopping ||
            !running
          ) {
            return;
          }
          const message =
            error instanceof Error ? error.message : String(error);
          setWhatsAppConnectionState(account.accountId, {
            status: "error",
            lastError: message,
          });
          scheduleReconnect(message);
        });
      },
      { unref: true },
    );
  }

  async function connect(): Promise<void> {
    clearWhatsAppReconnectTimer();
    connectionGeneration += 1;
    const generation = connectionGeneration;
    if (sock) await typing.clearOwner(sock);
    clearActiveSocket(true);
    await ensureRuntimeHelpers();
    connectedAtMs = reconnectScheduler.now();
    const result = await (dependencies.createSocket ?? createWhatsAppSocket)({
      accountId: account.accountId,
      printQr: true,
      messageStore,
      onConnectionUpdate(update) {
        if (generation !== connectionGeneration) return CLAIM_CONNECTION_STATE;
        if (update.connection === "open") {
          if (stopping || !running || closedGeneration === generation) {
            return CLAIM_CONNECTION_STATE;
          }
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
          if (isWhatsAppConflictDisconnect(update)) {
            closedGeneration = generation;
            const closingSocket = sock;
            if (closingSocket) void typing.clearOwner(closingSocket);
            clearActiveSocket(false);
            const lastDisconnect = asRecord(update.lastDisconnect);
            const error = asRecord(lastDisconnect.error);
            running = false;
            stopping = true;
            clearWhatsAppReconnectTimer();
            clearStableOpenTimer();
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
            return CLAIM_CONNECTION_STATE;
          }
          if (closedGeneration === generation) return CLAIM_CONNECTION_STATE;
          closedGeneration = generation;
          const closingSocket = sock;
          if (closingSocket) void typing.clearOwner(closingSocket);
          clearActiveSocket(false);
          const lastDisconnect = asRecord(update.lastDisconnect);
          const error = asRecord(lastDisconnect.error);
          const now = reconnectScheduler.now();
          while (recentDisconnects.length > 0) {
            const oldest = recentDisconnects[0];
            if (oldest === undefined || now - oldest <= RECONNECT_WINDOW_MS) {
              break;
            }
            recentDisconnects.shift();
          }
          recentDisconnects.push(now);
          if (recentDisconnects.length >= MAX_UNSTABLE_DISCONNECTS) {
            running = false;
            stopping = true;
            clearWhatsAppReconnectTimer();
            clearStableOpenTimer();
            const loopMessage = `WhatsApp disconnected ${recentDisconnects.length} times in ${RECONNECT_WINDOW_MS / 1000}s; stopping to avoid reconnect loop. Another client may be competing for this session. Restart this WhatsApp channel to retry.`;
            setWhatsAppConnectionState(account.accountId, {
              status: "error",
              lastError: loopMessage,
            });
            console.warn(`[WhatsApp:${account.accountId}] ${loopMessage}`);
            return CLAIM_CONNECTION_STATE;
          }
          scheduleReconnect(
            typeof error.message === "string" ? error.message : undefined,
          );
        }
        if (update.connection === "close" && stopping) {
          return CLAIM_CONNECTION_STATE;
        }
        return undefined;
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
    const connectedSocket = result.sock as WhatsAppSocket;
    sock = connectedSocket;
    releaseSocketLease = result.release;
    connectedSocket.ev?.on?.("messages.upsert", (event) => {
      return handleMessagesUpsert(event, connectedSocket, generation).catch(
        (error) => {
          console.error(
            `[WhatsApp:${account.accountId}] inbound handler failed:`,
            error instanceof Error ? error.message : error,
          );
        },
      );
    });
    connectedSocket.ev?.on?.("messages.reaction", (event) => {
      return handleReactionBatch(event, connectedSocket, generation).catch(
        (error) => {
          console.error(
            `[WhatsApp:${account.accountId}] reaction handler failed:`,
            error instanceof Error ? error.message : error,
          );
        },
      );
    });
  }

  async function getGroupLabel(
    groupJid: string,
    batchSocket: WhatsAppSocket,
  ): Promise<string | undefined> {
    try {
      return (await batchSocket.groupMetadata?.(groupJid))?.subject;
    } catch {
      return undefined;
    }
  }

  function isActiveBatch(
    batchSocket: WhatsAppSocket,
    generation: number,
  ): boolean {
    return (
      running &&
      !stopping &&
      sock === batchSocket &&
      generation === connectionGeneration
    );
  }

  async function handleMessagesUpsert(
    event: unknown,
    batchSocket: WhatsAppSocket,
    generation: number,
  ): Promise<void> {
    const acceptedEntries: Array<
      WhatsAppInboundDebounceEntry<WhatsAppSocket, WhatsAppMessageKey>
    > = [];
    try {
      if (!isActiveBatch(batchSocket, generation)) return;
      const record = asRecord(event);
      if (record.type !== "notify" && record.type !== "append") return;
      const messages = Array.isArray(record.messages)
        ? (record.messages as WhatsAppMessage[])
        : [];
      const isHistory = record.type === "append";
      for (const msg of messages) {
        if (!isActiveBatch(batchSocket, generation)) return;
        const remoteJid = msg.key?.remoteJid ?? "";
        const messageId = msg.key?.id ?? "";
        if (!remoteJid || !messageId || !msg.message) continue;
        if (isWhatsAppReactionMessage(msg.message)) continue;
        if (isStatusOrBroadcastJid(remoteJid)) continue;
        if (outboundMessages.isSent(messageId)) {
          outboundMessages.rememberStored(messageId, msg);
          outboundMessages.forgetSent(messageId);
          continue;
        }
        if (!messageStore.has(messageId)) {
          outboundMessages.rememberStored(messageId, msg);
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

        const identity = resolveInboundIdentity(
          {
            selfPhoneJid,
            selfLid,
            remoteJid,
            participant: msg.key?.participant,
            senderPn: msg.key?.senderPn,
            senderLid: msg.key?.senderLid,
            participantPn: msg.key?.participantPn,
            participantLid: msg.key?.participantLid,
          },
          lidStore,
        );
        if (!identity || !applyObservedMappings(identity.observedMappings)) {
          continue;
        }

        const group = isGroupJid(remoteJid);
        const chatId = identity.chatId;
        const dedupeKey = `${chatId}:${messageId}`;
        if (!dedupeClaims.tryClaim(dedupeKey, generation)) continue;

        const text = extractWhatsAppText(msg.message);
        let attachmentResult: Awaited<
          ReturnType<typeof collectWhatsAppAttachments>
        >;
        try {
          attachmentResult = await collectWhatsAppAttachments({
            accountId: account.accountId,
            chatId,
            messageId,
            message: msg.message,
            downloadContentFromMessage: downloadContentFromMessage ?? undefined,
            downloadMedia: account.downloadMedia === true,
            mediaMaxBytes: account.mediaMaxBytes,
            transcribeVoice: account.transcribeVoice === true,
          });
        } catch (error) {
          dedupeClaims.release(dedupeKey, generation);
          throw error;
        }
        if (!isActiveBatch(batchSocket, generation)) {
          dedupeClaims.release(dedupeKey, generation);
          return;
        }
        const body = attachmentResult.transcriptionText || text;
        if (!body.trim() && attachmentResult.attachments.length === 0) {
          dedupeClaims.commit(dedupeKey, generation);
          continue;
        }

        const senderId = identity.senderId;

        const mentionedJids = extractMentionedJids(msg.message);
        const replyParticipant = extractReplyParticipant(msg.message);
        const groupAllowed = !group
          ? true
          : shouldProcessWhatsAppGroup({
              account,
              groupJid: chatId,
              text: body,
              mentionedJids,
              replyParticipant,
              selfPhoneJid,
              selfLid,
            });
        if (!groupAllowed) {
          dedupeClaims.commit(dedupeKey, generation);
          continue;
        }

        const chatLabel = group
          ? await getGroupLabel(chatId, batchSocket)
          : selfChat
            ? "Self (WhatsApp)"
            : msg.pushName?.trim() || senderId;
        if (!isActiveBatch(batchSocket, generation)) {
          dedupeClaims.release(dedupeKey, generation);
          return;
        }

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
          `[WhatsApp:${account.accountId}] inbound chatId=${chatId} sender=${senderId} text="${previewWhatsAppText(body)}"`,
        );
        acceptedEntries.push({
          inbound,
          receipt:
            msg.key && batchSocket.readMessages
              ? {
                  owner: batchSocket,
                  key: msg.key,
                  markRead: (keys) => batchSocket.readMessages?.(keys),
                }
              : undefined,
          onDeliveryStarted: () => dedupeClaims.commit(dedupeKey, generation),
          onDiscarded: () => dedupeClaims.release(dedupeKey, generation),
        });
      }
    } finally {
      flushLidStoreIfDirty();
      if (acceptedEntries.length > 0) {
        if (isActiveBatch(batchSocket, generation)) {
          await inboundDebounce?.dispatch(acceptedEntries);
        } else {
          for (const entry of acceptedEntries) entry.onDiscarded?.();
        }
      }
    }
  }

  async function handleReactionEntry(
    parsed: WhatsAppReaction,
    raw: unknown,
    batchSocket: WhatsAppSocket,
    generation: number,
  ): Promise<void> {
    if (!isActiveBatch(batchSocket, generation)) return;
    // Baileys may deliver reactions via a LID chat where it cannot equate
    // our PN identity, producing targetFromMe:false for our own messages.
    // isKnownOutboundMessage also checks sentMessageIds and the store's
    // key.fromMe, but not mere store membership because inbound messages
    // are stored there too.
    const targetIsOurs =
      parsed.targetFromMe === true ||
      outboundMessages.isKnownOutbound(parsed.targetMessageId);
    if (!targetIsOurs) return;
    if (parsed.reactionKey.fromMe === true) return;
    if (isStatusOrBroadcastJid(parsed.chatId)) return;
    if (
      parsed.timestampMs !== undefined &&
      parsed.timestampMs < connectedAtMs - 1000
    ) {
      return;
    }
    if (outboundMessages.isSent(parsed.reactionMessageId)) {
      outboundMessages.forgetSent(parsed.reactionMessageId);
      return;
    }
    const identity = resolveInboundIdentity(
      {
        selfPhoneJid,
        selfLid,
        remoteJid: parsed.chatId,
        participant: parsed.reactorParticipant,
        senderPn: parsed.reactionKey.senderPn,
        senderLid: parsed.reactionKey.senderLid,
        participantPn: parsed.reactionKey.participantPn,
        participantLid: parsed.reactionKey.participantLid,
      },
      lidStore,
    );
    if (!identity || !applyObservedMappings(identity.observedMappings)) return;
    const dedupeKey = `reaction:${identity.chatId}:${parsed.reactionMessageId}`;
    if (!dedupeClaims.tryClaim(dedupeKey, generation)) return;

    const selfChat = isSelfChat(parsed.chatId, selfPhoneJid, selfLid);
    if (account.selfChatMode && !selfChat) {
      dedupeClaims.commit(dedupeKey, generation);
      return;
    }

    const group = isGroupJid(identity.chatId);
    if (
      group &&
      !isWhatsAppReactionGroupEligible({
        groupMode: account.groupMode,
        allowedGroups: account.allowedGroups,
        groupJid: identity.chatId,
        targetFromMe: targetIsOurs,
      })
    ) {
      dedupeClaims.commit(dedupeKey, generation);
      return;
    }

    const chatLabel = group
      ? await getGroupLabel(identity.chatId, batchSocket)
      : selfChat
        ? "Self (WhatsApp)"
        : identity.senderId;
    if (!isActiveBatch(batchSocket, generation)) {
      dedupeClaims.release(dedupeKey, generation);
      return;
    }
    const targetSenderId = isStrictPhoneJid(selfPhoneJid)
      ? senderIdFromJid(selfPhoneJid)
      : isStrictPhoneJid(parsed.targetKey.participant)
        ? senderIdFromJid(parsed.targetKey.participant)
        : undefined;
    const actor = identity.senderId;
    const text =
      parsed.action === "added"
        ? `${actor} reacted ${parsed.emoji}`
        : `${actor} removed a reaction`;
    const inbound: InboundChannelMessage = {
      channel: CHANNEL_ID,
      accountId: account.accountId,
      chatId: identity.chatId,
      senderId: actor,
      senderName: actor,
      chatLabel,
      text,
      timestamp: parsed.timestampMs ?? Date.now(),
      messageId: parsed.reactionMessageId,
      chatType: group ? "channel" : "direct",
      isMention: !group || account.groupMode === "mention",
      raw,
      reaction: {
        action: parsed.action,
        emoji: parsed.emoji,
        targetMessageId: parsed.targetMessageId,
        ...(targetSenderId ? { targetSenderId } : {}),
      },
    };

    dedupeClaims.commit(dedupeKey, generation);
    try {
      await adapter.onMessage?.(inbound);
    } catch (error) {
      console.error(
        `[WhatsApp:${account.accountId}] reaction delivery failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  async function handleReactionBatch(
    event: unknown,
    batchSocket: WhatsAppSocket,
    generation: number,
  ): Promise<void> {
    try {
      if (!isActiveBatch(batchSocket, generation) || !Array.isArray(event)) {
        return;
      }
      for (const raw of event) {
        if (!isActiveBatch(batchSocket, generation)) return;
        try {
          const parsed = parseWhatsAppReactionEntry(raw);
          if (parsed) {
            await handleReactionEntry(parsed, raw, batchSocket, generation);
          }
        } catch (error) {
          console.error(
            `[WhatsApp:${account.accountId}] reaction entry failed:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    } finally {
      flushLidStoreIfDirty();
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
      resolveLid: (lidJid) => lidStore.resolve(lidJid),
    });
    return await sock.sendMessage(targetJid, payload, options);
  }

  const adapter: ChannelAdapter = {
    id: `${CHANNEL_ID}:${account.accountId}`,
    channelId: CHANNEL_ID,
    accountId: account.accountId,
    name: getWhatsAppDisplayName(account),

    async start() {
      if (running) return;
      running = true;
      stopping = false;
      reconnectAttempts = 0;
      recentDisconnects.length = 0;
      closedGeneration = null;
      await connect();
      console.log(`[WhatsApp:${account.accountId}] Adapter started.`);
    },

    async stop() {
      const wasRunning = running;
      stopping = true;
      running = false;
      inboundDebounce?.cancelPending();
      clearWhatsAppReconnectTimer();
      clearStableOpenTimer();
      connectionGeneration += 1;
      await typing.clearAll();
      clearActiveSocket(true);
      if (wasRunning) {
        setWhatsAppConnectionState(account.accountId, {
          status: "disconnected",
        });
      }
      outboundMessages.clear();
      flushLidStoreIfDirty();
    },

    isRunning() {
      return running;
    },

    async sendMessage(msg: OutboundChannelMessage) {
      if (!running) throw new Error("WhatsApp adapter is not running.");
      if (
        !msg.text?.trim() &&
        !msg.mediaPath?.trim() &&
        !msg.reaction &&
        !msg.removeReaction
      ) {
        throw new Error("WhatsApp send requires message or media.");
      }
      const targetJid = resolveSendJid({
        chatId: msg.chatId,
        selfPhoneJid,
        selfLid,
        resolveLid: (lidJid) => lidStore.resolve(lidJid),
      });
      const hadManagedTyping = typing.isActive(targetJid);
      await typing.clearChat(targetJid);
      let resolvedMedia: WhatsAppResolvedOutboundMedia | undefined;
      if (msg.mediaPath && account.attachmentFilter === true) {
        const decision = decideWhatsAppAttachmentPolicy({
          policy: {
            enabled: true,
            allowedMimeTypes: account.attachmentMimeTypes ?? [],
            allowedRecipients: account.attachmentAllowedRecipients ?? [],
            allowedDirectories: account.attachmentAllowedPaths ?? [],
            recursiveDirectories: account.attachmentPathRecursive === true,
          },
          mediaPath: msg.mediaPath,
          targetJid,
        });
        if (!decision.allowed) {
          throw new Error(decision.reason);
        }
        resolvedMedia = {
          mediaPath: decision.mediaPath,
          mimeType: decision.mimeType,
        };
      }
      if (msg.reaction || msg.removeReaction) {
        const target = msg.targetMessageId ?? msg.replyToMessageId;
        if (!target) throw new Error("WhatsApp reactions require messageId.");
        const result = await sendToWhatsApp(targetJid, {
          react: {
            text: msg.removeReaction ? "" : (msg.reaction ?? ""),
            key: outboundMessages.buildReactionTargetKey(targetJid, target),
          },
        });
        const id = result.key?.id ?? target;
        outboundMessages.rememberSent(id, result);
        return { messageId: id };
      }
      if (!hadManagedTyping) {
        try {
          await sock?.sendPresenceUpdate?.("composing", targetJid);
        } catch {
          // Presence is best-effort.
        }
      }
      const payload = withWhatsAppPayloadMessagePrefix(
        buildWhatsAppOutboundPayload(msg, resolvedMedia),
        account.messagePrefix,
      );
      const result = await sendToWhatsApp(
        targetJid,
        payload,
        buildWhatsAppQuotedOptions(targetJid, msg.replyToMessageId),
      );
      const id = result.key?.id ?? "";
      outboundMessages.rememberSent(id, result);
      return { messageId: id };
    },

    async sendDirectReply(chatId, text, options) {
      if (!running || !text.trim()) return;
      const targetJid = resolveSendJid({
        chatId,
        selfPhoneJid,
        selfLid,
        resolveLid: (lidJid) => lidStore.resolve(lidJid),
      });
      await typing.clearChat(targetJid);
      const payload = withWhatsAppPayloadMessagePrefix(
        { text },
        options?.applyMessagePrefix ? account.messagePrefix : undefined,
      );
      const result = await sendToWhatsApp(
        targetJid,
        payload,
        buildWhatsAppQuotedOptions(targetJid, options?.replyToMessageId),
      );
      outboundMessages.rememberSent(result.key?.id ?? "", result);
    },

    async handleControlRequestEvent(event: ChannelControlRequestEvent) {
      // Never post approval/control prompts into groups.
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
      if (event.type === "queued") return;
      if (event.type === "processing") {
        if (account.waitingBehavior === "typing_indicator") {
          for (const source of event.sources) {
            typing.start({ batchId: event.batchId, source });
          }
        }
        return;
      }

      await Promise.all(
        event.sources.map((source) =>
          typing.stop({ batchId: event.batchId, source }),
        ),
      );

      const errorText = event.outcome === "error" ? event.error?.trim() : null;
      if (!errorText) return;

      const uniqueSources = new Map<string, ChannelTurnSource>();
      for (const source of event.sources) {
        const key = getWhatsAppLifecycleErrorReplyKey(source);
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

  inboundDebounce = createWhatsAppInboundDebounceController({
    account,
    getDeliver: () => adapter.onMessage,
    onDeliveryError(error) {
      console.warn(
        `[WhatsApp:${account.accountId}] failed to deliver inbound batch:`,
        error instanceof Error ? error.message : error,
      );
    },
    onReadReceiptError(error) {
      console.warn(
        `[WhatsApp:${account.accountId}] failed to mark messages read:`,
        error instanceof Error ? error.message : error,
      );
    },
  });
  typing = createWhatsAppTypingController<WhatsAppSocket>({
    accountId: account.accountId,
    canonicalizeChatId,
    getOwner: getTypingOwner,
    sendPresence: sendTypingPresence,
  });

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
