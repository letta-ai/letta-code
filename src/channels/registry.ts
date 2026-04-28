/**
 * Channel Registry — singleton that manages channel adapters, routing,
 * pairing, and the ingress pipeline.
 *
 * Lifecycle:
 * 1. initializeChannels() creates adapters from channel accounts
 * 2. Adapters start long-polling (buffer inbound until ready)
 * 3. setReady() is called from inside startListenerClient() once closure state exists
 * 4. Buffered messages flush through the registered onMessage handler
 */

import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { getClient } from "../agent/client";
import { ISOLATED_BLOCK_LABELS } from "../agent/memory";
import type { ApprovalResponseBody } from "../types/protocol_v2";
import {
  getChannelAccount,
  LEGACY_CHANNEL_ACCOUNT_ID,
  listChannelAccounts,
  loadChannelAccounts,
} from "./accounts";
import {
  formatChannelControlRequestPrompt,
  parseChannelControlRequestResponse,
} from "./interactive";
import {
  consumePairingCode,
  createPairingCode,
  isUserApproved,
  loadPairingStore,
  rollbackPairingApproval,
} from "./pairing";
import {
  listPendingControlRequests as listPersistedPendingControlRequests,
  removePendingControlRequest as removePersistedPendingControlRequest,
  upsertPendingControlRequest as upsertPersistedPendingControlRequest,
} from "./pendingControlRequests";
import { loadChannelPlugin } from "./pluginRegistry";
import {
  addRoute,
  getRoute as getRouteFromStore,
  getRouteRaw,
  getRoutesForChannel,
  loadRoutes,
  removeRouteInMemory,
  setRouteInMemory,
} from "./routing";
import { loadTargetStore, upsertChannelTarget } from "./targets";
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
  ChannelRoute,
  ChannelTurnLifecycleEvent,
  ChannelTurnSource,
  DiscordChannelAccount,
  InboundChannelMessage,
  SlackChannelAccount,
  SlackDefaultPermissionMode,
} from "./types";
import { formatChannelNotification } from "./xml";

function channelDisplayName(channelId: string): string {
  if (channelId === "slack") return "Slack";
  if (channelId === "discord") return "Discord";
  return "Telegram";
}

function buildPairingInstructions(channelId: string, code: string): string {
  const displayName = channelDisplayName(channelId);
  return (
    `To connect this chat to a Letta Code agent, open Channels > ${displayName} in Letta Code and finish connecting this chat there.\n\n` +
    `Pairing code: ${code}\n\n` +
    `This code expires in 15 minutes.`
  );
}

function buildUnboundRouteInstructions(
  channelId: string,
  chatId: string,
): string {
  const displayName = channelDisplayName(channelId);
  return (
    `This chat isn't bound to a Letta Code agent yet.\n\n` +
    `Open Channels > ${displayName} in Letta Code and connect this chat there.\n\n` +
    `Chat ID: ${chatId}`
  );
}

function buildSlackAppSetupInstructions(): string {
  return (
    "This Slack app isn't connected to a Letta agent yet.\n\n" +
    "Open Channels > Slack in Letta Code, choose which agent this app should represent, and try again."
  );
}

function truncateChannelSummaryPreview(
  text: string,
  maxLength = 72,
): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function buildSlackConversationSummary(
  msg: Pick<
    InboundChannelMessage,
    "chatId" | "chatLabel" | "chatType" | "senderId" | "senderName" | "text"
  >,
): string {
  if (msg.chatType === "direct") {
    return `[Slack] DM with ${msg.senderName?.trim() || msg.senderId}`;
  }

  const preview = truncateChannelSummaryPreview(msg.text);
  const channelLabel =
    msg.chatLabel && msg.chatLabel !== msg.chatId ? ` in ${msg.chatLabel}` : "";

  if (preview) {
    return `[Slack] Thread${channelLabel}: ${preview}`;
  }

  return `[Slack] Thread${channelLabel || ` ${msg.chatId}`}`;
}

function buildDiscordConversationSummary(
  msg: Pick<
    InboundChannelMessage,
    "chatId" | "chatLabel" | "chatType" | "senderId" | "senderName" | "text"
  >,
): string {
  if (msg.chatType === "direct") {
    return `[Discord] DM with ${msg.senderName?.trim() || msg.senderId}`;
  }

  const preview = truncateChannelSummaryPreview(msg.text);
  const channelLabel =
    msg.chatLabel && msg.chatLabel !== msg.chatId ? ` in ${msg.chatLabel}` : "";

  if (preview) {
    return `[Discord] Thread${channelLabel}: ${preview}`;
  }

  return `[Discord] Thread${channelLabel || ` ${msg.chatId}`}`;
}

function buildChannelTurnSource(
  route: ChannelRoute,
  msg: Pick<
    InboundChannelMessage,
    "channel" | "accountId" | "chatId" | "chatType" | "messageId" | "threadId"
  >,
): ChannelTurnSource {
  return {
    channel: msg.channel as ChannelTurnSource["channel"],
    accountId: msg.accountId,
    chatId: msg.chatId,
    chatType: msg.chatType,
    messageId: msg.messageId,
    threadId: msg.threadId,
    agentId: route.agentId,
    conversationId: route.conversationId,
  };
}

function getChannelApprovalScopeKey(params: {
  channel: string;
  accountId?: string;
  chatId: string;
  threadId?: string | null;
}): string {
  return [
    params.channel,
    params.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID,
    params.chatId,
    params.threadId ?? "",
  ].join(":");
}

// ── Singleton ─────────────────────────────────────────────────────

let instance: ChannelRegistry | null = null;

export function getChannelRegistry(): ChannelRegistry | null {
  return instance;
}

export function ensureChannelRegistry(): ChannelRegistry {
  return instance ?? new ChannelRegistry();
}

export function getActiveChannelIds(): string[] {
  if (!instance) return [];
  return instance.getActiveChannelIds();
}

// ── Types ─────────────────────────────────────────────────────────

export interface ChannelInboundDelivery {
  route: ChannelRoute;
  content: MessageCreate["content"];
  turnSources?: ChannelTurnSource[];
}

export type ChannelMessageHandler = (delivery: ChannelInboundDelivery) => void;
export type ChannelApprovalResponseHandler = (params: {
  runtime: {
    agent_id?: string | null;
    conversation_id?: string | null;
  };
  response: ApprovalResponseBody;
}) => Promise<boolean>;

type PendingChannelControlRequest = {
  event: ChannelControlRequestEvent;
  deliveredThisProcess: boolean;
};

export type ChannelRegistryEvent =
  | {
      type: "pairings_updated";
      channelId: string;
    }
  | {
      type: "targets_updated";
      channelId: string;
    }
  | {
      type: "slack_conversation_created";
      channelId: "slack";
      accountId: string;
      agentId: string;
      conversationId: string;
      defaultPermissionMode: SlackDefaultPermissionMode;
    };

// ── Registry ──────────────────────────────────────────────────────

export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private ready = false;
  private messageHandler: ChannelMessageHandler | null = null;
  private eventHandler: ((event: ChannelRegistryEvent) => void) | null = null;
  private approvalResponseHandler: ChannelApprovalResponseHandler | null = null;
  private readonly buffer: ChannelInboundDelivery[] = [];
  private readonly pendingControlRequestsById = new Map<
    string,
    PendingChannelControlRequest
  >();
  private readonly pendingControlRequestIdByScope = new Map<string, string>();

  constructor() {
    if (instance) {
      throw new Error(
        "ChannelRegistry is a singleton — use getChannelRegistry()",
      );
    }
    instance = this;
    this.primePersistedPendingControlRequests();
  }

  // ── Adapter management ────────────────────────────────────────

  private getAdapterKey(
    channelId: string,
    accountId = LEGACY_CHANNEL_ACCOUNT_ID,
  ): string {
    return `${channelId}:${accountId}`;
  }

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(
      this.getAdapterKey(adapter.channelId ?? adapter.id, adapter.accountId),
      adapter,
    );

    // Wire the adapter's onMessage to our ingress pipeline
    adapter.onMessage = async (msg: InboundChannelMessage) => {
      await this.handleInboundMessage(msg);
    };
  }

  getAdapter(
    channelId: string,
    accountId = LEGACY_CHANNEL_ACCOUNT_ID,
  ): ChannelAdapter | null {
    return this.adapters.get(this.getAdapterKey(channelId, accountId)) ?? null;
  }

  getActiveChannelIds(): string[] {
    return Array.from(this.adapters.values())
      .filter((adapter) => adapter.isRunning())
      .map((adapter) => adapter.channelId ?? adapter.id);
  }

  async dispatchTurnLifecycleEvent(
    event: ChannelTurnLifecycleEvent,
  ): Promise<void> {
    const groups = new Map<
      string,
      {
        adapter: ChannelAdapter;
        sources: ChannelTurnSource[];
      }
    >();

    const sources = event.type === "queued" ? [event.source] : event.sources;
    for (const source of sources) {
      const adapter = this.getAdapter(
        source.channel,
        source.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID,
      );
      if (!adapter?.handleTurnLifecycleEvent) {
        continue;
      }
      const groupKey = this.getAdapterKey(
        source.channel,
        source.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID,
      );
      const existing = groups.get(groupKey);
      if (existing) {
        existing.sources.push(source);
        continue;
      }
      groups.set(groupKey, {
        adapter,
        sources: [source],
      });
    }

    for (const { adapter, sources: groupedSources } of groups.values()) {
      const handleTurnLifecycleEvent = adapter.handleTurnLifecycleEvent;
      if (!handleTurnLifecycleEvent) {
        continue;
      }
      try {
        if (event.type === "queued") {
          const [firstSource] = groupedSources;
          if (!firstSource) {
            continue;
          }
          await handleTurnLifecycleEvent({
            type: "queued",
            source: firstSource,
          });
          continue;
        }
        await handleTurnLifecycleEvent({
          ...event,
          sources: groupedSources,
        });
      } catch (error) {
        console.error(
          `[Channels] Failed to handle ${event.type} lifecycle event for ${adapter.channelId ?? adapter.id}/${adapter.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  // ── Readiness / ingress handler ───────────────────────────────

  /**
   * Set the message handler and mark the registry as ready.
   * Called from inside startListenerClient() with closure-scoped state.
   */
  setMessageHandler(handler: ChannelMessageHandler): void {
    this.messageHandler = handler;
  }

  setApprovalResponseHandler(
    handler: ChannelApprovalResponseHandler | null,
  ): void {
    this.approvalResponseHandler = handler;
  }

  setEventHandler(
    handler: ((event: ChannelRegistryEvent) => void) | null,
  ): void {
    this.eventHandler = handler;
  }

  hasPendingControlRequest(requestId: string): boolean {
    return this.pendingControlRequestsById.has(requestId);
  }

  getPendingControlRequests(): Array<PendingChannelControlRequest> {
    return Array.from(this.pendingControlRequestsById.values()).map(
      (pending) => ({
        event: structuredClone(pending.event),
        deliveredThisProcess: pending.deliveredThisProcess,
      }),
    );
  }

  private primePersistedPendingControlRequests(): void {
    for (const event of listPersistedPendingControlRequests()) {
      this.pendingControlRequestsById.set(event.requestId, {
        event,
        deliveredThisProcess: false,
      });
      this.pendingControlRequestIdByScope.set(
        getChannelApprovalScopeKey({
          channel: event.source.channel,
          accountId: event.source.accountId,
          chatId: event.source.chatId,
          threadId: event.source.threadId,
        }),
        event.requestId,
      );
    }
  }

  private async deliverPendingControlRequest(
    requestId: string,
  ): Promise<boolean> {
    const pending = this.pendingControlRequestsById.get(requestId);
    if (!pending) {
      return false;
    }

    const event = pending.event;
    const adapter = this.getAdapter(
      event.source.channel,
      event.source.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID,
    );
    if (!adapter) {
      return false;
    }

    try {
      if (adapter.handleControlRequestEvent) {
        await adapter.handleControlRequestEvent(event);
      } else {
        await adapter.sendDirectReply(
          event.source.chatId,
          formatChannelControlRequestPrompt(event),
          {
            replyToMessageId: event.source.threadId ?? event.source.messageId,
          },
        );
      }
      pending.deliveredThisProcess = true;
      return true;
    } catch (error) {
      console.error(
        `[Channels] Failed to deliver control request prompt for ${event.source.channel}/${event.source.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID}:`,
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  async registerPendingControlRequest(
    event: ChannelControlRequestEvent,
  ): Promise<void> {
    const scopeKey = getChannelApprovalScopeKey({
      channel: event.source.channel,
      accountId: event.source.accountId,
      chatId: event.source.chatId,
      threadId: event.source.threadId,
    });
    const existingRequestId = this.pendingControlRequestIdByScope.get(scopeKey);
    if (existingRequestId) {
      this.clearPendingControlRequest(existingRequestId);
    }
    this.pendingControlRequestsById.set(event.requestId, {
      event,
      deliveredThisProcess: false,
    });
    this.pendingControlRequestIdByScope.set(scopeKey, event.requestId);
    upsertPersistedPendingControlRequest(event);
    await this.deliverPendingControlRequest(event.requestId);
  }

  async redeliverPendingControlRequest(requestId: string): Promise<boolean> {
    return this.deliverPendingControlRequest(requestId);
  }

  clearPendingControlRequest(requestId: string): void {
    removePersistedPendingControlRequest(requestId);
    const pending = this.pendingControlRequestsById.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingControlRequestsById.delete(requestId);
    const scopeKey = getChannelApprovalScopeKey({
      channel: pending.event.source.channel,
      accountId: pending.event.source.accountId,
      chatId: pending.event.source.chatId,
      threadId: pending.event.source.threadId,
    });
    if (this.pendingControlRequestIdByScope.get(scopeKey) === requestId) {
      this.pendingControlRequestIdByScope.delete(scopeKey);
    }
  }

  /**
   * Mark the registry as ready, flushing any buffered messages.
   */
  setReady(): void {
    this.ready = true;
    this.flushBuffer();
  }

  /**
   * Check if the registry is ready to deliver messages.
   */
  isReady(): boolean {
    return this.ready && this.messageHandler !== null;
  }

  // ── Routing ───────────────────────────────────────────────────

  getRoute(
    channel: string,
    chatId: string,
    accountId?: string,
    threadId?: string | null,
  ): ChannelRoute | null {
    if (accountId) {
      return getRouteFromStore(channel, chatId, accountId, threadId);
    }

    const matches = getRoutesForChannel(channel).filter(
      (route) =>
        route.chatId === chatId &&
        (threadId === undefined
          ? true
          : (route.threadId ?? null) === (threadId ?? null)),
    );
    if (matches.length !== 1) {
      return null;
    }
    return matches[0] ?? null;
  }

  getRouteForScope(
    channel: string,
    chatId: string,
    agentId: string,
    conversationId: string,
  ): ChannelRoute | null {
    const matches = getRoutesForChannel(channel).filter(
      (route) =>
        route.chatId === chatId &&
        route.agentId === agentId &&
        route.conversationId === conversationId &&
        route.enabled,
    );

    if (matches.length !== 1) {
      return null;
    }

    return matches[0] ?? null;
  }

  async startChannel(channelId: string): Promise<boolean> {
    loadChannelAccounts(channelId);
    const accounts = listChannelAccounts(channelId).filter(
      (account) => account.enabled,
    );
    if (accounts.length === 0) {
      return false;
    }

    let started = false;
    for (const account of accounts) {
      started =
        (await this.startChannelAccount(channelId, account.accountId)) ||
        started;
    }
    return started;
  }

  async startChannelAccount(
    channelId: string,
    accountId: string,
  ): Promise<boolean> {
    loadChannelAccounts(channelId);
    const account = getChannelAccount(channelId, accountId);
    if (!account) {
      return false;
    }

    loadRoutes(channelId);
    loadPairingStore(channelId);
    loadTargetStore(channelId);

    const existing = this.getAdapter(channelId, accountId);
    if (existing?.isRunning()) {
      await existing.stop();
    }
    this.adapters.delete(this.getAdapterKey(channelId, accountId));

    const plugin = await loadChannelPlugin(account.channel);
    const adapter = await plugin.createAdapter(account);
    this.registerAdapter(adapter);
    await adapter.start();
    return true;
  }

  async stopChannel(channelId: string): Promise<boolean> {
    const adapters = Array.from(this.adapters.values()).filter(
      (adapter) => adapter.channelId === channelId,
    );
    if (adapters.length === 0) {
      return false;
    }

    for (const adapter of adapters) {
      if (adapter.isRunning()) {
        await adapter.stop();
      }
      this.adapters.delete(
        this.getAdapterKey(
          adapter.channelId ?? adapter.id,
          adapter.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID,
        ),
      );
    }

    return true;
  }

  async stopChannelAccount(
    channelId: string,
    accountId: string,
  ): Promise<boolean> {
    const adapter = this.getAdapter(channelId, accountId);
    if (!adapter) {
      return false;
    }
    if (adapter.isRunning()) {
      await adapter.stop();
    }
    this.adapters.delete(this.getAdapterKey(channelId, accountId));
    return true;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async startAll(): Promise<void> {
    for (const adapter of Array.from(this.adapters.values())) {
      if (!adapter.isRunning()) {
        await adapter.start();
      }
    }
  }

  /**
   * Pause delivery without stopping adapters.
   * Called on WS disconnect — adapters keep polling, messages buffer.
   * On reconnect, wireChannelIngress re-registers the handler and calls setReady().
   */
  pause(): void {
    this.ready = false;
    this.messageHandler = null;
    this.eventHandler = null;
    this.approvalResponseHandler = null;
  }

  /**
   * Fully stop all adapters and destroy the singleton.
   * Only called on actual process shutdown, NOT on WS disconnect.
   */
  async stopAll(): Promise<void> {
    for (const adapter of Array.from(this.adapters.values())) {
      if (adapter.isRunning()) {
        await adapter.stop();
      }
    }
    this.ready = false;
    this.messageHandler = null;
    this.eventHandler = null;
    this.approvalResponseHandler = null;
    this.pendingControlRequestsById.clear();
    this.pendingControlRequestIdByScope.clear();
    instance = null;
  }

  // ── Inbound message pipeline ──────────────────────────────────

  private async tryHandlePendingControlRequest(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
  ): Promise<boolean> {
    const scopeKey = getChannelApprovalScopeKey({
      channel: msg.channel,
      accountId: msg.accountId,
      chatId: msg.chatId,
      threadId: msg.threadId,
    });
    const requestId = this.pendingControlRequestIdByScope.get(scopeKey);
    if (!requestId) {
      return false;
    }

    const pending = this.pendingControlRequestsById.get(requestId);
    if (!pending) {
      this.pendingControlRequestIdByScope.delete(scopeKey);
      return false;
    }

    const parsed = parseChannelControlRequestResponse(pending.event, msg.text);
    if (parsed.type === "reprompt") {
      await adapter.sendDirectReply(msg.chatId, parsed.message, {
        replyToMessageId: msg.threadId ?? msg.messageId,
      });
      return true;
    }

    if (!this.approvalResponseHandler) {
      await adapter.sendDirectReply(
        msg.chatId,
        "I’m reconnecting to Letta Code right now, so I couldn’t use that reply yet. Please send it again in a moment.",
        {
          replyToMessageId: msg.threadId ?? msg.messageId,
        },
      );
      return true;
    }

    const handled = await this.approvalResponseHandler({
      runtime: {
        agent_id: pending.event.source.agentId,
        conversation_id: pending.event.source.conversationId,
      },
      response: parsed.response,
    });

    this.clearPendingControlRequest(requestId);

    if (!handled) {
      await adapter.sendDirectReply(
        msg.chatId,
        "That approval prompt expired before I could use your reply. Please ask the agent to try again.",
        {
          replyToMessageId: msg.threadId ?? msg.messageId,
        },
      );
    }

    return true;
  }

  private async handleInboundMessage(
    msg: InboundChannelMessage,
  ): Promise<void> {
    const accountId = msg.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    const adapter = this.getAdapter(msg.channel, accountId);
    if (!adapter) return;
    if (await this.tryHandlePendingControlRequest(adapter, msg)) {
      return;
    }
    const config = getChannelAccount(msg.channel, accountId);
    if (!config) return;

    if (msg.channel === "slack" && config.channel === "slack") {
      const slackResult = await this.ensureSlackRoute(adapter, msg, config);
      if (!slackResult) {
        return;
      }
      const preparedMessage = adapter.prepareInboundMessage
        ? await adapter.prepareInboundMessage(msg, {
            isFirstRouteTurn: slackResult.isFirstRouteTurn,
          })
        : msg;
      this.deliverOrBuffer({
        route: slackResult.route,
        content: formatChannelNotification(preparedMessage),
        turnSources: [
          buildChannelTurnSource(slackResult.route, preparedMessage),
        ],
      });
      return;
    }

    // Discord guild messages and account-bound DMs use auto-routing (like
    // Slack). DMs configured with explicit pairing fall through to the
    // standard pairing flow below.
    if (
      msg.channel === "discord" &&
      config.channel === "discord" &&
      (msg.chatType === "channel" || config.dmPolicy !== "pairing")
    ) {
      const discordResult = await this.ensureDiscordRoute(adapter, msg, config);
      if (!discordResult) {
        return;
      }
      const preparedMessage = adapter.prepareInboundMessage
        ? await adapter.prepareInboundMessage(msg, {
            isFirstRouteTurn: discordResult.isFirstRouteTurn,
          })
        : msg;
      this.deliverOrBuffer({
        route: discordResult.route,
        content: formatChannelNotification(preparedMessage),
        turnSources: [
          buildChannelTurnSource(discordResult.route, preparedMessage),
        ],
      });
      return;
    }

    // 1. Check pairing/allowlist policy
    if (config.dmPolicy === "allowlist") {
      if (!config.allowedUsers.includes(msg.senderId)) {
        if (msg.reaction) {
          return;
        }
        await adapter.sendDirectReply(
          msg.chatId,
          "You are not on the allowed users list for this bot.",
        );
        return;
      }
    } else if (config.dmPolicy === "pairing") {
      // Reload pairing store from disk on miss (allows standalone CLI pairing)
      if (!isUserApproved(msg.channel, msg.senderId, accountId)) {
        loadPairingStore(msg.channel);
      }
      if (!isUserApproved(msg.channel, msg.senderId, accountId)) {
        if (msg.reaction) {
          return;
        }
        // Generate pairing code
        const code = createPairingCode(
          msg.channel,
          msg.senderId,
          msg.chatId,
          msg.senderName,
          accountId,
        );
        this.eventHandler?.({
          type: "pairings_updated",
          channelId: msg.channel,
        });
        await adapter.sendDirectReply(
          msg.chatId,
          buildPairingInstructions(msg.channel, code),
        );
        return;
      }
    }
    // dm_policy === "open" → skip check

    // 2. Route lookup (reload from disk on miss — allows standalone CLI pairing)
    let route = getRouteFromStore(
      msg.channel,
      msg.chatId,
      accountId,
      msg.threadId,
    );
    if (!route) {
      loadRoutes(msg.channel);
      route = getRouteFromStore(
        msg.channel,
        msg.chatId,
        accountId,
        msg.threadId,
      );
    }
    if (!route) {
      await adapter.sendDirectReply(
        msg.chatId,
        buildUnboundRouteInstructions(msg.channel, msg.chatId),
      );
      return;
    }

    // 3. Format as XML
    const content = formatChannelNotification(msg);

    // 4. Deliver or buffer
    this.deliverOrBuffer({
      route,
      content,
      turnSources: [buildChannelTurnSource(route, msg)],
    });
  }

  private async createConversationForAgent(
    agentId: string,
    summary?: string,
  ): Promise<string> {
    const client = await getClient();
    const conversation = await client.conversations.create({
      agent_id: agentId,
      isolated_block_labels: [...ISOLATED_BLOCK_LABELS],
      ...(summary ? { summary } : {}),
    });
    return conversation.id;
  }

  private async createSlackRoute(
    config: SlackChannelAccount,
    msg: InboundChannelMessage,
  ): Promise<ChannelRoute> {
    if (!config.agentId) {
      throw new Error("Slack app is missing an agent binding.");
    }

    const conversationId = await this.createConversationForAgent(
      config.agentId,
      buildSlackConversationSummary(msg),
    );
    const now = new Date().toISOString();
    const route: ChannelRoute = {
      accountId: config.accountId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      threadId:
        msg.chatType === "channel"
          ? (msg.threadId ?? msg.messageId ?? null)
          : null,
      agentId: config.agentId,
      conversationId,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    addRoute(msg.channel, route);
    if (config.defaultPermissionMode !== "default") {
      this.eventHandler?.({
        type: "slack_conversation_created",
        channelId: "slack",
        accountId: config.accountId,
        agentId: config.agentId,
        conversationId,
        defaultPermissionMode: config.defaultPermissionMode,
      });
    }
    return route;
  }

  private async ensureSlackRoute(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    config: SlackChannelAccount,
  ): Promise<{
    route: ChannelRoute;
    isFirstRouteTurn: boolean;
  } | null> {
    if (!config.agentId) {
      await adapter.sendDirectReply(
        msg.chatId,
        buildSlackAppSetupInstructions(),
        msg.chatType === "channel" && msg.threadId
          ? { replyToMessageId: msg.threadId }
          : msg.messageId
            ? { replyToMessageId: msg.messageId }
            : undefined,
      );
      return null;
    }

    if (msg.chatType === "direct") {
      if (
        config.dmPolicy === "allowlist" &&
        !config.allowedUsers.includes(msg.senderId)
      ) {
        await adapter.sendDirectReply(
          msg.chatId,
          "You are not on the allowed users list for this Slack app.",
        );
        return null;
      }
    }

    const accountId = msg.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    const routeThreadId =
      msg.chatType === "channel" ? (msg.threadId ?? null) : null;
    let route = getRouteFromStore(
      msg.channel,
      msg.chatId,
      accountId,
      routeThreadId,
    );
    if (!route) {
      loadRoutes(msg.channel);
      route = getRouteFromStore(
        msg.channel,
        msg.chatId,
        accountId,
        routeThreadId,
      );
    }

    if (route) {
      return {
        route,
        isFirstRouteTurn: false,
      };
    }

    if (msg.chatType === "channel" && !msg.isMention) {
      return null;
    }

    const now = new Date().toISOString();
    loadTargetStore(msg.channel);
    upsertChannelTarget(msg.channel, {
      accountId,
      targetId: msg.chatId,
      targetType: "channel",
      chatId: msg.chatId,
      label: msg.chatLabel ?? `Slack channel ${msg.chatId}`,
      discoveredAt: now,
      lastSeenAt: now,
      lastMessageId: msg.messageId,
    });
    this.eventHandler?.({
      type: "targets_updated",
      channelId: msg.channel,
    });

    return {
      route: await this.createSlackRoute(config, msg),
      isFirstRouteTurn: true,
    };
  }

  private async createDiscordRoute(
    config: DiscordChannelAccount,
    msg: InboundChannelMessage,
  ): Promise<ChannelRoute> {
    if (!config.agentId) {
      throw new Error("Discord bot is missing an agent binding.");
    }

    const conversationId = await this.createConversationForAgent(
      config.agentId,
      buildDiscordConversationSummary(msg),
    );
    const now = new Date().toISOString();
    const route: ChannelRoute = {
      accountId: config.accountId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      threadId: msg.threadId ?? null,
      agentId: config.agentId,
      conversationId,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    addRoute(msg.channel, route);
    return route;
  }

  private async ensureDiscordRoute(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    config: DiscordChannelAccount,
  ): Promise<{
    route: ChannelRoute;
    isFirstRouteTurn: boolean;
  } | null> {
    if (!config.agentId) {
      await adapter.sendDirectReply(
        msg.chatId,
        "This Discord bot isn't connected to a Letta agent yet.\n\n" +
          "Open Channels > Discord in Letta Code, choose which agent this bot should represent, and try again.",
      );
      return null;
    }

    if (
      msg.chatType === "direct" &&
      config.dmPolicy === "allowlist" &&
      !config.allowedUsers.includes(msg.senderId)
    ) {
      await adapter.sendDirectReply(
        msg.chatId,
        "You are not on the allowed users list for this Discord bot.",
      );
      return null;
    }

    const accountId = msg.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    const routeThreadId = msg.threadId ?? null;
    let route = getRouteFromStore(
      msg.channel,
      msg.chatId,
      accountId,
      routeThreadId,
    );
    if (!route) {
      loadRoutes(msg.channel);
      route = getRouteFromStore(
        msg.channel,
        msg.chatId,
        accountId,
        routeThreadId,
      );
    }

    if (route) {
      return { route, isFirstRouteTurn: false };
    }

    // In guild channels, only create routes from explicit mentions.
    // Existing routed threads continue above via the route lookup path.
    if (msg.chatType === "channel" && !msg.isMention) {
      return null;
    }

    return {
      route: await this.createDiscordRoute(config, msg),
      isFirstRouteTurn: true,
    };
  }

  private deliverOrBuffer(delivery: ChannelInboundDelivery): void {
    if (this.isReady()) {
      this.messageHandler?.(delivery);
      return;
    }

    this.buffer.push(delivery);
  }

  private flushBuffer(): void {
    if (!this.messageHandler) return;

    while (this.buffer.length > 0) {
      const item = this.buffer.shift();
      if (item) {
        this.messageHandler(item);
      }
    }
  }
}

// ── Initialization ────────────────────────────────────────────────

/**
 * Initialize the channel system.
 *
 * 1. Creates the ChannelRegistry singleton
 * 2. Loads configs, routing tables, and pairing stores
 * 3. Creates adapters for each requested channel
 * 4. Starts adapters (begin long-polling, buffer until ready)
 *
 * Does NOT set the message handler or mark ready — that happens
 * inside startListenerClient() when closure state is available.
 */
export async function initializeChannels(
  channelNames: string[],
): Promise<ChannelRegistry> {
  const registry = ensureChannelRegistry();

  for (const channelId of channelNames) {
    loadChannelAccounts(channelId);
    const accounts = listChannelAccounts(channelId);
    if (accounts.length === 0) {
      console.error(
        `Channel "${channelId}" not configured. Run: letta channels configure ${channelId}`,
      );
      continue;
    }

    for (const account of accounts) {
      if (!account.enabled) {
        continue;
      }

      try {
        await registry.startChannelAccount(channelId, account.accountId);
      } catch (error) {
        console.error(
          `[Channels] Failed to start ${channelId}/${account.accountId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  return registry;
}

/**
 * Complete a pairing and create a route (atomic operation).
 *
 * Validates the pairing code, approves the user, and binds their
 * chat to the specified agent+conversation.
 */
export function completePairing(
  channelId: string,
  code: string,
  agentId: string,
  conversationId: string,
  accountId?: string,
): { success: boolean; error?: string; chatId?: string; accountId?: string } {
  const pending = consumePairingCode(channelId, code, accountId);
  if (!pending) {
    return { success: false, error: "Invalid or expired pairing code." };
  }

  const resolvedAccountId = pending.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;

  // Snapshot existing route so we can restore it on failure
  const previousRoute = getRouteRaw(
    channelId,
    pending.chatId,
    resolvedAccountId,
  );

  // Create route — roll back pairing approval AND in-memory route if this fails
  try {
    const now = new Date().toISOString();
    addRoute(channelId, {
      accountId: resolvedAccountId,
      chatId: pending.chatId,
      chatType: "direct",
      threadId: null,
      agentId,
      conversationId,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    // Restore in-memory route to prior state (no disk write — disk is what failed)
    if (previousRoute) {
      setRouteInMemory(channelId, previousRoute);
    } else {
      removeRouteInMemory(channelId, pending.chatId, resolvedAccountId, null);
    }
    // Roll back: re-add the pending code and remove the approved user
    rollbackPairingApproval(channelId, pending);
    const msg = err instanceof Error ? err.message : "unknown error";
    return {
      success: false,
      error: `Pairing approved but route creation failed (rolled back): ${msg}`,
    };
  }

  return {
    success: true,
    chatId: pending.chatId,
    accountId: resolvedAccountId,
  };
}
