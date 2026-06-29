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
import { getBackend } from "@/backend";
import { buildChatUrl, isLocalAgentId } from "@/cli/helpers/app-urls";
import type { ApprovalResponseBody } from "@/types/protocol_v2";
import {
  getChannelAccount,
  getChannelAccountWithSecrets,
  hydrateChannelAccountSecrets,
  LEGACY_CHANNEL_ACCOUNT_ID,
  listChannelAccounts,
  listChannelAccountsWithSecrets,
} from "./accounts";
import {
  buildChannelAlreadyActiveMessage,
  buildChannelAlreadyPausedMessage,
  buildChannelCancelNoActiveTurnMessage,
  buildChannelCancelUnavailableMessage,
  buildChannelChatLinkMessage,
  buildChannelChatUnavailableMessage,
  buildChannelModelUnavailableMessage,
  buildChannelNoRouteMessage,
  buildChannelPausedMessage,
  buildChannelReflectionUnavailableMessage,
  buildChannelResumedMessage,
  parseChannelSlashCommand,
  tryHandleChannelSlashCommand,
} from "./commands";
import { getChannelAccountsPath, getChannelsRoot } from "./config";
import { isDiscordGuildChannelAllowed } from "./discord/channel-gating";
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
} from "./pending-control-requests";
import {
  getChannelDisplayName,
  getSupportedChannelIds,
  isFirstPartyChannelPlugin,
  loadChannelPlugin,
} from "./plugin-registry";
import type { ChannelRestoreAgentScope } from "./restore-scope";
import { shouldRestoreChannelAccountForAgentScope } from "./restore-scope";
import {
  addRoute,
  getRoute as getRouteFromStore,
  getRouteRaw,
  getRoutesForChannel,
  loadRoutes,
  removeRouteInMemory,
  setRouteInMemory,
} from "./routing";
import { signalAllowedUsersIncludes } from "./signal/target";
import { loadTargetStore, upsertChannelTarget } from "./targets";
import type {
  ChannelAccount,
  ChannelAdapter,
  ChannelControlRequestEvent,
  ChannelDefaultPermissionMode,
  ChannelRoute,
  ChannelStartupLogger,
  ChannelTurnLifecycleEvent,
  ChannelTurnProgressEvent,
  ChannelTurnSource,
  DiscordChannelAccount,
  InboundChannelMessage,
  SignalChannelAccount,
  SlackChannelAccount,
  TelegramChannelAccount,
  WhatsAppChannelAccount,
} from "./types";
import {
  isDiscordChannelAccount,
  isSignalChannelAccount,
  isSlackChannelAccount,
  isTelegramChannelAccount,
  isWhatsAppChannelAccount,
} from "./types";
import { allowedUsersIncludes } from "./whatsapp/jid";
import { subscribeWhatsAppConnectionState } from "./whatsapp/state";
import { formatChannelNotification } from "./xml";

function channelDisplayName(channelId: string): string {
  try {
    return getChannelDisplayName(channelId);
  } catch {
    return channelId;
  }
}

type PairingInstructionOptions = {
  agentId?: string | null;
};

type AccountAgentIdSource = {
  agentId?: string | null;
  binding?: {
    agentId?: string | null;
  };
};

function normalizeAgentId(agentId: string | null | undefined): string | null {
  const normalized = agentId?.trim();
  return normalized ? normalized : null;
}

function normalizeSignalBaseUrlForConflictKey(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl.trim().replace(/\/+$/, "");
  }
}

function findSignalBaseUrlConflict(
  accounts: SignalChannelAccount[],
): { baseUrl: string; accountIds: string[] } | null {
  const byBaseUrl = new Map<string, string[]>();
  for (const account of accounts) {
    if (!account.enabled) continue;
    const key = normalizeSignalBaseUrlForConflictKey(account.baseUrl);
    const accountIds = byBaseUrl.get(key) ?? [];
    accountIds.push(account.accountId);
    byBaseUrl.set(key, accountIds);
  }
  for (const [baseUrl, accountIds] of byBaseUrl.entries()) {
    if (accountIds.length > 1) {
      return { baseUrl, accountIds };
    }
  }
  return null;
}

function findSignalBaseUrlConflictForStart(
  accounts: SignalChannelAccount[],
  accountToStart: SignalChannelAccount,
): { baseUrl: string; accountIds: string[] } | null {
  const targetBaseUrl = normalizeSignalBaseUrlForConflictKey(
    accountToStart.baseUrl,
  );
  const accountIds = accounts
    .filter(
      (account) =>
        account.accountId !== accountToStart.accountId &&
        account.enabled &&
        normalizeSignalBaseUrlForConflictKey(account.baseUrl) === targetBaseUrl,
    )
    .map((account) => account.accountId);
  if (accountIds.length === 0) {
    return null;
  }
  return {
    baseUrl: targetBaseUrl,
    accountIds: [accountToStart.accountId, ...accountIds],
  };
}

function buildSignalBaseUrlConflictError(conflict: {
  baseUrl: string;
  accountIds: string[];
}): string {
  return `Signal accounts ${conflict.accountIds.join(", ")} share base_url ${conflict.baseUrl}. Native signal-cli event streams cannot safely run multiple enabled accounts on the same daemon; disable all but one account or run separate signal-cli daemons on separate ports/config dirs.`;
}

function getConfiguredAgentId(config: unknown): string | null {
  if (!config || typeof config !== "object") {
    return null;
  }
  const source = config as AccountAgentIdSource;
  return (
    normalizeAgentId(source.agentId) ??
    normalizeAgentId(source.binding?.agentId)
  );
}

export function buildPairingInstructions(
  channelId: string,
  code: string,
  options: PairingInstructionOptions = {},
): string {
  // First-party channels (telegram, slack, discord) have UI in the desktop
  // app. Community plugins installed under ~/.letta/channels/<id>/ do not,
  // so the user-facing copy needs to point at CLI commands instead.
  const displayName = channelDisplayName(channelId);
  const configuredAgentId = normalizeAgentId(options.agentId);
  const pairingCommand = `letta channels pair --channel ${channelId} --code ${code} --agent ${configuredAgentId ?? "<agent-id>"}`;
  const agentLookupLines = configuredAgentId
    ? []
    : ["Find the target agent with: letta agents list"];
  if (!isFirstPartyChannelPlugin(channelId)) {
    return [
      "Connect this chat to a Letta agent.",
      "",
      `Pairing code: ${code}`,
      "",
      "CLI on the listener machine:",
      pairingCommand,
      ...agentLookupLines,
      "",
      "This code expires in 15 minutes.",
    ].join("\n");
  }
  return [
    "Connect this chat to a Letta agent.",
    "",
    `Pairing code: ${code}`,
    "",
    `In Letta Code: open Channels > ${displayName} and approve this pending chat.`,
    "",
    "CLI on the listener machine:",
    pairingCommand,
    ...agentLookupLines,
    "",
    "This code expires in 15 minutes.",
  ].join("\n");
}

export function buildUnboundRouteInstructions(
  channelId: string,
  chatId: string,
): string {
  const displayName = channelDisplayName(channelId);
  if (!isFirstPartyChannelPlugin(channelId)) {
    return (
      `This chat isn't connected to a Letta agent yet.\n\n` +
      `On the machine where your listener runs:\n\n` +
      `letta channels route add --channel ${channelId} --chat-id ${chatId} --agent <agent-id>\n\n` +
      `Find your agent id with letta agents list.`
    );
  }
  return (
    `This chat isn't connected to a Letta agent yet.\n\n` +
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
    | "chatId"
    | "chatLabel"
    | "chatType"
    | "senderId"
    | "senderName"
    | "text"
    | "threadId"
  >,
): string {
  if (msg.chatType === "direct") {
    if (msg.threadId?.trim()) {
      const preview = truncateChannelSummaryPreview(msg.text);
      return preview
        ? `[Slack] DM thread with ${msg.senderName?.trim() || msg.senderId}: ${preview}`
        : `[Slack] DM thread with ${msg.senderName?.trim() || msg.senderId}`;
    }
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

function buildTelegramConversationSummary(
  msg: Pick<
    InboundChannelMessage,
    "chatId" | "chatLabel" | "chatType" | "senderId" | "senderName" | "text"
  >,
): string {
  if (msg.chatType === "direct") {
    return `[Telegram] DM with ${msg.senderName?.trim() || msg.senderId}`;
  }

  const preview = truncateChannelSummaryPreview(msg.text);
  const channelLabel =
    msg.chatLabel && msg.chatLabel !== msg.chatId ? ` in ${msg.chatLabel}` : "";

  if (preview) {
    return `[Telegram] Topic${channelLabel}: ${preview}`;
  }

  return `[Telegram] Topic${channelLabel || ` ${msg.chatId}`}`;
}

function buildWhatsAppConversationSummary(
  msg: Pick<
    InboundChannelMessage,
    "chatId" | "chatLabel" | "chatType" | "senderId" | "senderName" | "text"
  >,
): string {
  if (msg.chatType === "direct") {
    return `[WhatsApp] DM with ${msg.senderName?.trim() || msg.senderId}`;
  }

  const textPreview = truncateChannelSummaryPreview(msg.text);
  const channelLabel =
    msg.chatLabel && msg.chatLabel !== msg.chatId ? ` in ${msg.chatLabel}` : "";

  if (textPreview) {
    return `[WhatsApp] Group${channelLabel}: ${textPreview}`;
  }

  return `[WhatsApp] Group${channelLabel || ` ${msg.chatId}`}`;
}

function buildSignalConversationSummary(
  msg: Pick<
    InboundChannelMessage,
    "chatId" | "chatLabel" | "chatType" | "senderId" | "senderName" | "text"
  >,
): string {
  if (msg.chatType === "direct") {
    return `[Signal] DM with ${msg.senderName?.trim() || msg.senderId}`;
  }

  const textPreview = truncateChannelSummaryPreview(msg.text);
  const channelLabel =
    msg.chatLabel && msg.chatLabel !== msg.chatId ? ` in ${msg.chatLabel}` : "";

  if (textPreview) {
    return `[Signal] Group${channelLabel}: ${textPreview}`;
  }

  return `[Signal] Group${channelLabel || ` ${msg.chatId}`}`;
}

function buildChannelTurnSource(
  route: ChannelRoute,
  msg: Pick<
    InboundChannelMessage,
    | "channel"
    | "accountId"
    | "chatId"
    | "chatType"
    | "senderId"
    | "senderTeamId"
    | "messageId"
    | "threadId"
  >,
): ChannelTurnSource {
  return {
    channel: msg.channel as ChannelTurnSource["channel"],
    accountId: msg.accountId,
    chatId: msg.chatId,
    chatType: msg.chatType,
    senderId: msg.senderId,
    senderTeamId: msg.senderTeamId,
    messageId: msg.messageId,
    threadId: msg.threadId,
    agentId: route.agentId,
    conversationId: route.conversationId,
  };
}

function buildDirectReplyOptions(
  msg: Pick<InboundChannelMessage, "messageId" | "threadId">,
): { replyToMessageId?: string; threadId?: string | null } | undefined {
  if (!msg.messageId && !msg.threadId) {
    return undefined;
  }
  return {
    replyToMessageId: msg.threadId ?? msg.messageId ?? undefined,
    threadId: msg.threadId ?? null,
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
  defaultPermissionMode?: ChannelDefaultPermissionMode;
}

export type ChannelMessageHandler = (delivery: ChannelInboundDelivery) => void;
export type ChannelApprovalResponseHandler = (params: {
  runtime: {
    agent_id?: string | null;
    conversation_id?: string | null;
  };
  response: ApprovalResponseBody;
}) => Promise<boolean>;

export type ChannelCancelHandler = (params: {
  runtime: {
    agent_id: string;
    conversation_id: string;
  };
}) => Promise<boolean>;

export type ChannelReflectionHandler = (params: {
  runtime: {
    agent_id: string;
    conversation_id: string;
  };
}) => Promise<{
  handled: boolean;
  text?: string;
}>;

export type ChannelModelHandler = (params: {
  channelId: string;
  runtime: {
    agent_id: string;
    conversation_id: string;
  };
  modelIdentifier?: string;
}) => Promise<{
  handled: boolean;
  text?: string;
}>;

type ChannelStartupOptions = {
  logger?: ChannelStartupLogger;
};

export interface ChannelStartupFailure {
  channelId: string;
  accountId?: string;
  error: string;
}

export class ChannelInitializationError extends Error {
  constructor(public readonly failures: ChannelStartupFailure[]) {
    super(formatChannelStartupFailures(failures));
    this.name = "ChannelInitializationError";
  }
}

function logChannelStartup(
  logger: ChannelStartupLogger | undefined,
  message: string,
): void {
  logger?.(`[Channels] ${message}`);
}

function formatChannelStartupError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

export function formatChannelStartupFailures(
  failures: ChannelStartupFailure[],
): string {
  const failedChannels = Array.from(
    new Set(failures.map((failure) => failure.channelId)),
  );
  const lines = failures.map((failure) => {
    const label = failure.accountId
      ? `${failure.channelId}/${failure.accountId}`
      : failure.channelId;
    return `- ${label}: ${failure.error}`;
  });

  return [
    "Failed to start requested channel listeners.",
    ...lines,
    "",
    "The listener is not running for these channels.",
    `Install missing runtimes with: letta server --channels ${failedChannels.join(",")} --install-channel-runtimes`,
    "Or install them once with:",
    ...failedChannels.map(
      (channelId) => `  letta channels install ${channelId}`,
    ),
  ].join("\n");
}

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
      type: "channel_account_state_updated";
      channelId: string;
      accountId: string;
    }
  | {
      type: "slack_conversation_created";
      channelId: "slack";
      accountId: string;
      agentId: string;
      conversationId: string;
      defaultPermissionMode: ChannelDefaultPermissionMode;
    }
  | {
      type: "discord_conversation_created";
      channelId: "discord";
      accountId: string;
      agentId: string;
      conversationId: string;
      defaultPermissionMode: ChannelDefaultPermissionMode;
    };

// ── Registry ──────────────────────────────────────────────────────

export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private ready = false;
  private messageHandler: ChannelMessageHandler | null = null;
  private eventHandler: ((event: ChannelRegistryEvent) => void) | null = null;
  private approvalResponseHandler: ChannelApprovalResponseHandler | null = null;
  private cancelHandler: ChannelCancelHandler | null = null;
  private reflectionHandler: ChannelReflectionHandler | null = null;
  private modelHandler: ChannelModelHandler | null = null;
  private readonly buffer: ChannelInboundDelivery[] = [];
  private readonly pendingControlRequestsById = new Map<
    string,
    PendingChannelControlRequest
  >();
  private readonly pendingControlRequestIdByScope = new Map<string, string>();
  private readonly unsubscribeWhatsAppState: () => void;

  constructor() {
    if (instance) {
      throw new Error(
        "ChannelRegistry is a singleton — use getChannelRegistry()",
      );
    }
    instance = this;
    this.unsubscribeWhatsAppState = subscribeWhatsAppConnectionState(
      (accountId) => {
        this.eventHandler?.({
          type: "channel_account_state_updated",
          channelId: "whatsapp",
          accountId,
        });
      },
    );
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
          await handleTurnLifecycleEvent.call(adapter, {
            type: "queued",
            source: firstSource,
          });
          continue;
        }
        await handleTurnLifecycleEvent.call(adapter, {
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

  async dispatchTurnProgressEvent(
    event: ChannelTurnProgressEvent,
  ): Promise<void> {
    const groups = new Map<
      string,
      {
        adapter: ChannelAdapter;
        sources: ChannelTurnSource[];
      }
    >();

    for (const source of event.sources) {
      const adapter = this.getAdapter(
        source.channel,
        source.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID,
      );
      if (!adapter?.handleTurnProgressEvent) {
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
      const handleTurnProgressEvent = adapter.handleTurnProgressEvent;
      if (!handleTurnProgressEvent) {
        continue;
      }
      try {
        await handleTurnProgressEvent.call(adapter, {
          ...event,
          sources: groupedSources,
        });
      } catch (error) {
        console.error(
          `[Channels] Failed to handle progress event for ${adapter.channelId ?? adapter.id}/${adapter.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID}:`,
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

  setCancelHandler(handler: ChannelCancelHandler | null): void {
    this.cancelHandler = handler;
  }

  setReflectionHandler(handler: ChannelReflectionHandler | null): void {
    this.reflectionHandler = handler;
  }

  setModelHandler(handler: ChannelModelHandler | null): void {
    this.modelHandler = handler;
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
    accountId?: string,
  ): ChannelRoute | null {
    const normalizedAccountId = accountId?.trim();
    const matches = getRoutesForChannel(channel).filter(
      (route) =>
        route.chatId === chatId &&
        route.agentId === agentId &&
        route.conversationId === conversationId &&
        route.outboundEnabled !== false &&
        (!normalizedAccountId ||
          (route.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID) ===
            normalizedAccountId) &&
        route.enabled,
    );

    if (matches.length !== 1) {
      return null;
    }

    return matches[0] ?? null;
  }

  async startChannel(channelId: string): Promise<boolean> {
    const accounts = (await listChannelAccountsWithSecrets(channelId)).filter(
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
    options?: ChannelStartupOptions,
  ): Promise<boolean> {
    logChannelStartup(options?.logger, `starting ${channelId}/${accountId}`);
    const account = await getChannelAccountWithSecrets(channelId, accountId);
    if (!account) {
      logChannelStartup(
        options?.logger,
        `account not found: ${channelId}/${accountId}`,
      );
      return false;
    }

    if (isSignalChannelAccount(account)) {
      const conflict = findSignalBaseUrlConflictForStart(
        (await listChannelAccountsWithSecrets("signal")).filter(
          isSignalChannelAccount,
        ),
        account,
      );
      if (conflict) {
        const error = buildSignalBaseUrlConflictError(conflict);
        logChannelStartup(options?.logger, error);
        throw new Error(error);
      }
    }

    logChannelStartup(
      options?.logger,
      `loading route, pairing, and target stores for ${channelId}/${accountId}`,
    );
    loadRoutes(channelId);
    loadPairingStore(channelId);
    loadTargetStore(channelId);

    const existing = this.getAdapter(channelId, accountId);
    if (existing?.isRunning()) {
      logChannelStartup(
        options?.logger,
        `stopping existing adapter for ${channelId}/${accountId}`,
      );
      await existing.stop();
    }
    this.adapters.delete(this.getAdapterKey(channelId, accountId));

    logChannelStartup(
      options?.logger,
      `loading plugin for ${account.channel}/${accountId}`,
    );
    const plugin = await loadChannelPlugin(account.channel);
    logChannelStartup(
      options?.logger,
      `creating adapter for ${account.channel}/${accountId}`,
    );
    const adapter = await plugin.createAdapter(account);
    this.registerAdapter(adapter);
    logChannelStartup(
      options?.logger,
      `starting adapter for ${account.channel}/${accountId}`,
    );
    await adapter.start({ logger: options?.logger });
    logChannelStartup(
      options?.logger,
      `started adapter for ${account.channel}/${accountId}`,
    );
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
    this.cancelHandler = null;
    this.reflectionHandler = null;
    this.modelHandler = null;
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
    this.cancelHandler = null;
    this.reflectionHandler = null;
    this.modelHandler = null;
    this.pendingControlRequestsById.clear();
    this.pendingControlRequestIdByScope.clear();
    this.unsubscribeWhatsAppState();
    instance = null;
  }

  // ── Inbound message pipeline ──────────────────────────────────

  private async tryHandlePendingControlRequest(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
  ): Promise<boolean> {
    const slashCommand = parseChannelSlashCommand(msg.text);
    if (slashCommand) {
      return false;
    }

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
      await adapter.sendDirectReply(
        msg.chatId,
        parsed.message,
        buildDirectReplyOptions(msg),
      );
      return true;
    }

    if (!this.approvalResponseHandler) {
      await adapter.sendDirectReply(
        msg.chatId,
        "I’m reconnecting to Letta Code right now, so I couldn’t use that reply yet. Please send it again in a moment.",
        buildDirectReplyOptions(msg),
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
        buildDirectReplyOptions(msg),
      );
    }

    return true;
  }

  private findRawRouteForMessage(
    msg: InboundChannelMessage,
  ): ChannelRoute | null {
    return (
      getRouteRaw(msg.channel, msg.chatId, msg.accountId, msg.threadId) ?? null
    );
  }

  private loadAndFindRawRouteForMessage(
    msg: InboundChannelMessage,
  ): ChannelRoute | null {
    const route = this.findRawRouteForMessage(msg);
    if (route) {
      return route;
    }
    loadRoutes(msg.channel);
    return this.findRawRouteForMessage(msg);
  }

  private async handlePauseResumeSlashCommand(
    commandName: "pause" | "resume",
    msg: InboundChannelMessage,
  ): Promise<{ handled: boolean; text?: string }> {
    const route = this.loadAndFindRawRouteForMessage(msg);
    if (!route) {
      return {
        handled: true,
        text: buildChannelNoRouteMessage(msg.channel),
      };
    }

    if (commandName === "pause") {
      if (route.enabled === false) {
        return {
          handled: true,
          text: buildChannelAlreadyPausedMessage(msg.channel),
        };
      }
      const updatedRoute: ChannelRoute = {
        ...route,
        enabled: false,
        updatedAt: new Date().toISOString(),
      };
      addRoute(msg.channel, updatedRoute);
      return {
        handled: true,
        text: buildChannelPausedMessage(msg.channel, updatedRoute),
      };
    }

    if (route.enabled !== false) {
      return {
        handled: true,
        text: buildChannelAlreadyActiveMessage(msg.channel),
      };
    }
    const updatedRoute: ChannelRoute = {
      ...route,
      enabled: true,
      updatedAt: new Date().toISOString(),
    };
    addRoute(msg.channel, updatedRoute);
    return {
      handled: true,
      text: buildChannelResumedMessage(msg.channel, updatedRoute),
    };
  }

  private async handleCancelSlashCommand(
    msg: InboundChannelMessage,
  ): Promise<{ handled: boolean; text?: string }> {
    const route = this.getCancelRoute(msg);
    if (!route?.enabled || !this.cancelHandler) {
      return {
        handled: true,
        text: buildChannelCancelUnavailableMessage(msg.channel),
      };
    }

    const cancelled = await this.cancelHandler({
      runtime: {
        agent_id: route.agentId,
        conversation_id: route.conversationId,
      },
    });

    if (!cancelled) {
      return {
        handled: true,
        text: buildChannelCancelNoActiveTurnMessage(msg.channel),
      };
    }

    return { handled: true };
  }

  private async handleChatSlashCommand(
    msg: InboundChannelMessage,
  ): Promise<{ handled: boolean; text?: string }> {
    const route = this.loadAndFindRawRouteForMessage(msg);
    if (!route) {
      return {
        handled: true,
        text: buildChannelNoRouteMessage(msg.channel),
      };
    }

    if (isLocalAgentId(route.agentId)) {
      return {
        handled: true,
        text: buildChannelChatUnavailableMessage(msg.channel, route),
      };
    }

    return {
      handled: true,
      text: buildChannelChatLinkMessage(
        msg.channel,
        route,
        buildChatUrl(route.agentId, {
          conversationId: route.conversationId,
        }),
      ),
    };
  }

  private async handleReflectionSlashCommand(
    msg: InboundChannelMessage,
  ): Promise<{ handled: boolean; text?: string }> {
    const route = this.loadAndFindRawRouteForMessage(msg);
    if (!route?.enabled) {
      return {
        handled: true,
        text: buildChannelNoRouteMessage(msg.channel),
      };
    }

    if (!this.reflectionHandler) {
      return {
        handled: true,
        text: buildChannelReflectionUnavailableMessage(msg.channel),
      };
    }

    return this.reflectionHandler({
      runtime: {
        agent_id: route.agentId,
        conversation_id: route.conversationId,
      },
    });
  }

  private async handleModelSlashCommand(
    command: { args: string },
    msg: InboundChannelMessage,
  ): Promise<{ handled: boolean; text?: string }> {
    const route = this.loadAndFindRawRouteForMessage(msg);
    if (!route) {
      return {
        handled: true,
        text: buildChannelNoRouteMessage(msg.channel),
      };
    }

    if (!this.modelHandler) {
      return {
        handled: true,
        text: buildChannelModelUnavailableMessage(msg.channel),
      };
    }

    return this.modelHandler({
      channelId: msg.channel,
      runtime: {
        agent_id: route.agentId,
        conversation_id: route.conversationId,
      },
      modelIdentifier: command.args || undefined,
    });
  }

  private getCancelRoute(msg: InboundChannelMessage): ChannelRoute | null {
    let route = this.getRoute(
      msg.channel,
      msg.chatId,
      msg.accountId,
      msg.threadId,
    );
    if (route) {
      return route;
    }

    loadRoutes(msg.channel);
    route = this.getRoute(msg.channel, msg.chatId, msg.accountId, msg.threadId);
    if (route) {
      return route;
    }

    if (
      msg.channel !== "slack" ||
      msg.chatType !== "channel" ||
      msg.threadId != null
    ) {
      return null;
    }

    const accountId = msg.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    const matches = getRoutesForChannel(msg.channel, accountId).filter(
      (candidate) =>
        candidate.chatId === msg.chatId &&
        candidate.chatType === "channel" &&
        candidate.enabled,
    );

    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  private hasExactEnabledRouteForMessage(
    msg: InboundChannelMessage,
    accountId: string,
  ): boolean {
    if (getRouteFromStore(msg.channel, msg.chatId, accountId, msg.threadId)) {
      return true;
    }

    loadRoutes(msg.channel);
    return Boolean(
      getRouteFromStore(msg.channel, msg.chatId, accountId, msg.threadId),
    );
  }

  private shouldDropUnroutedSlackThreadInput(
    msg: InboundChannelMessage,
    accountId: string,
    config: ChannelAccount | null,
  ): boolean {
    return (
      msg.channel === "slack" &&
      msg.chatType === "channel" &&
      msg.threadId != null &&
      msg.isMention !== true &&
      (!config ||
        !isSlackChannelAccount(config) ||
        config.listenMode !== true) &&
      !this.hasExactEnabledRouteForMessage(msg, accountId)
    );
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

    if (this.shouldDropUnroutedSlackThreadInput(msg, accountId, config)) {
      return;
    }

    const getStatusRoute = (): ChannelRoute | null => {
      let statusRoute = getRouteFromStore(
        msg.channel,
        msg.chatId,
        accountId,
        msg.threadId,
      );
      if (!statusRoute) {
        loadRoutes(msg.channel);
        statusRoute = getRouteFromStore(
          msg.channel,
          msg.chatId,
          accountId,
          msg.threadId,
        );
      }
      return statusRoute;
    };

    if (
      await tryHandleChannelSlashCommand(adapter, msg, {
        statusContext: {
          adapterRunning: adapter.isRunning(),
          accountConfigured: !!config,
          accountEnabled: config?.enabled,
          route: getStatusRoute(),
        },
        handlers: {
          cancel: async (_command, commandMsg) =>
            this.handleCancelSlashCommand(commandMsg),
          chat: async (_command, commandMsg) =>
            this.handleChatSlashCommand(commandMsg),
          model: async (command, commandMsg) =>
            this.handleModelSlashCommand(command, commandMsg),
          pause: async () => this.handlePauseResumeSlashCommand("pause", msg),
          reflection: async (_command, commandMsg) =>
            this.handleReflectionSlashCommand(commandMsg),
          resume: async () => this.handlePauseResumeSlashCommand("resume", msg),
        },
      })
    ) {
      return;
    }

    if (!config) return;

    if (msg.channel === "slack" && isSlackChannelAccount(config)) {
      const slackResult = await this.ensureSlackRoute(adapter, msg, config);
      if (!slackResult) {
        return;
      }
      const preparedMessage = adapter.prepareInboundMessage
        ? await adapter.prepareInboundMessage(msg, {
            isFirstRouteTurn: slackResult.isFirstRouteTurn,
          })
        : msg;
      const turnSource = buildChannelTurnSource(
        slackResult.route,
        preparedMessage,
      );
      if (slackResult.route.outboundEnabled !== false) {
        await this.dispatchTurnLifecycleEvent({
          type: "queued",
          source: turnSource,
        });
      }
      this.deliverOrBuffer({
        route: slackResult.route,
        content: formatChannelNotification(preparedMessage),
        turnSources: [turnSource],
        defaultPermissionMode: config.defaultPermissionMode,
      });
      return;
    }

    // Telegram groups/supergroups can be used as public channel surfaces.
    // DMs keep the older explicit pairing flow below; group topics route by
    // chat_id + message_thread_id, which makes forum mode a surprisingly sane
    // threading primitive. Telegram, accidentally doing something useful.
    if (
      msg.channel === "telegram" &&
      isTelegramChannelAccount(config) &&
      msg.chatType === "channel"
    ) {
      if ((config.groupMode ?? "open") === "mention-only" && !msg.isMention) {
        return;
      }
      const telegramResult = await this.ensureTelegramRoute(
        adapter,
        msg,
        config,
      );
      if (!telegramResult) {
        return;
      }

      this.deliverOrBuffer({
        route: telegramResult.route,
        content: formatChannelNotification(msg),
        turnSources: [buildChannelTurnSource(telegramResult.route, msg)],
      });
      return;
    }

    // Discord guild messages and account-bound DMs use auto-routing (like
    // Slack). DMs configured with explicit pairing fall through to the
    // standard pairing flow below.
    if (
      msg.channel === "discord" &&
      isDiscordChannelAccount(config) &&
      (msg.chatType === "channel" || config.dmPolicy !== "pairing")
    ) {
      const discordResult = await this.ensureDiscordRoute(adapter, msg, config);
      if (!discordResult) {
        return;
      }

      // Delivery-time re-check: if allowed_channels changed since route creation,
      // drop the message (route cleanup, if desired, is handled separately by
      // reconcile + removeStaleRoutes).
      if (msg.chatType === "channel" && config.allowedChannels) {
        const isAllowed = isDiscordGuildChannelAllowed({
          channelId: msg.chatId,
          parentChannelId: msg.parentChannelId ?? null,
          isThread: !!(msg.threadId && msg.threadId === msg.chatId),
          allowedChannels: config.allowedChannels,
        });
        if (!isAllowed) {
          const resolvedParentId = msg.parentChannelId ?? null;
          const isThread = !!(msg.threadId && msg.threadId === msg.chatId);
          console.log(
            "[Discord] Delivery blocked by allowed_channels policy:",
            JSON.stringify({
              accountId: msg.accountId ?? config.accountId,
              chatId: msg.chatId,
              threadId: msg.threadId,
              resolvedParentId,
              reason: isThread
                ? `Thread "${msg.chatId}" parent channel "${resolvedParentId}" is not in allowed_channels`
                : `Guild channel "${msg.chatId}" is not in allowed_channels`,
            }),
          );
          return;
        }
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

    // WhatsApp sends through a linked human account, so the adapter performs
    // the conservative self-chat/group gates before messages reach here.
    // Direct chats can auto-route when not using pairing; groups auto-route
    // through the account binding.
    if (
      msg.channel === "whatsapp" &&
      isWhatsAppChannelAccount(config) &&
      (msg.chatType === "channel" || config.dmPolicy !== "pairing")
    ) {
      const whatsappResult = await this.ensureWhatsAppRoute(
        adapter,
        msg,
        config,
      );
      if (!whatsappResult) {
        return;
      }
      const preparedMessage = adapter.prepareInboundMessage
        ? await adapter.prepareInboundMessage(msg, {
            isFirstRouteTurn: whatsappResult.isFirstRouteTurn,
          })
        : msg;
      this.deliverOrBuffer({
        route: whatsappResult.route,
        content: formatChannelNotification(preparedMessage),
        turnSources: [
          buildChannelTurnSource(whatsappResult.route, preparedMessage),
        ],
      });
      return;
    }

    // Signal uses a linked signal-cli account. DMs can use pairing, but
    // account-bound DMs and configured groups auto-route like WhatsApp.
    if (
      msg.channel === "signal" &&
      isSignalChannelAccount(config) &&
      (msg.chatType === "channel" || config.dmPolicy !== "pairing")
    ) {
      const signalResult = await this.ensureSignalRoute(adapter, msg, config);
      if (!signalResult) {
        return;
      }
      const preparedMessage = adapter.prepareInboundMessage
        ? await adapter.prepareInboundMessage(msg, {
            isFirstRouteTurn: signalResult.isFirstRouteTurn,
          })
        : msg;
      this.deliverOrBuffer({
        route: signalResult.route,
        content: formatChannelNotification(preparedMessage),
        turnSources: [
          buildChannelTurnSource(signalResult.route, preparedMessage),
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
          buildPairingInstructions(msg.channel, code, {
            agentId: getConfiguredAgentId(config),
          }),
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

    // 3. Let adapters enrich inbound messages (e.g. thread context,
    // transcription, attachment hydration), then format as XML/content parts.
    const preparedMessage = adapter.prepareInboundMessage
      ? await adapter.prepareInboundMessage(msg, { isFirstRouteTurn: false })
      : msg;
    const content = formatChannelNotification(preparedMessage);

    // 4. Deliver or buffer
    this.deliverOrBuffer({
      route,
      content,
      turnSources: [buildChannelTurnSource(route, preparedMessage)],
    });
  }

  private async createConversationForAgent(
    agentId: string,
    summary?: string,
  ): Promise<string> {
    const conversation = await getBackend().createConversation({
      agent_id: agentId,
      ...(summary ? { summary } : {}),
    });
    return conversation.id;
  }

  private async createSlackRoute(
    config: SlackChannelAccount,
    msg: InboundChannelMessage,
    options: { outboundEnabled?: boolean } = {},
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
          : (msg.threadId ?? null),
      agentId: config.agentId,
      conversationId,
      enabled: true,
      outboundEnabled: options.outboundEnabled !== false,
      createdAt: now,
      updatedAt: now,
    };

    addRoute(msg.channel, route);
    this.eventHandler?.({
      type: "slack_conversation_created",
      channelId: "slack",
      accountId: config.accountId,
      agentId: config.agentId,
      conversationId,
      defaultPermissionMode: config.defaultPermissionMode,
    });
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
      if (msg.chatType === "channel" && msg.isMention !== true) {
        return null;
      }
      await adapter.sendDirectReply(
        msg.chatId,
        buildSlackAppSetupInstructions(),
        buildDirectReplyOptions(msg),
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
          buildDirectReplyOptions(msg),
        );
        return null;
      }
    }

    const accountId = msg.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    const routeThreadId =
      msg.channel === "slack" ? (msg.threadId ?? null) : null;
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
      if (
        msg.chatType === "channel" &&
        msg.isMention === true &&
        route.outboundEnabled === false
      ) {
        const updatedRoute: ChannelRoute = {
          ...route,
          outboundEnabled: true,
          updatedAt: new Date().toISOString(),
        };
        addRoute(msg.channel, updatedRoute);
        return {
          route: updatedRoute,
          isFirstRouteTurn: false,
        };
      }
      return {
        route,
        isFirstRouteTurn: false,
      };
    }

    const shouldCreateListenOnlyRoute =
      msg.chatType === "channel" &&
      msg.isMention !== true &&
      config.listenMode === true;

    if (
      msg.chatType === "channel" &&
      msg.isMention !== true &&
      !shouldCreateListenOnlyRoute
    ) {
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
      route: await this.createSlackRoute(config, msg, {
        outboundEnabled: !shouldCreateListenOnlyRoute,
      }),
      isFirstRouteTurn: true,
    };
  }

  private async createTelegramRoute(
    config: TelegramChannelAccount,
    msg: InboundChannelMessage,
  ): Promise<ChannelRoute> {
    if (!config.binding.agentId) {
      throw new Error("Telegram bot is missing an agent binding.");
    }

    const conversationId = await this.createConversationForAgent(
      config.binding.agentId,
      buildTelegramConversationSummary(msg),
    );
    const now = new Date().toISOString();
    const route: ChannelRoute = {
      accountId: config.accountId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      threadId: msg.threadId ?? null,
      agentId: config.binding.agentId,
      conversationId,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    addRoute(msg.channel, route);
    return route;
  }

  private async ensureTelegramRoute(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    config: TelegramChannelAccount,
  ): Promise<{
    route: ChannelRoute;
    isFirstRouteTurn: boolean;
  } | null> {
    if (!config.binding.agentId) {
      await adapter.sendDirectReply(
        msg.chatId,
        "This Telegram bot isn't connected to a Letta agent yet.\n\n" +
          "Open Channels > Telegram in Letta Code, choose which agent this bot should represent, and try again.",
        msg.messageId ? { replyToMessageId: msg.messageId } : undefined,
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

    const now = new Date().toISOString();
    loadTargetStore(msg.channel);
    upsertChannelTarget(msg.channel, {
      accountId,
      targetId: msg.threadId ? `${msg.chatId}:${msg.threadId}` : msg.chatId,
      targetType: "channel",
      chatId: msg.chatId,
      label: msg.chatLabel ?? `Telegram chat ${msg.chatId}`,
      discoveredAt: now,
      lastSeenAt: now,
      lastMessageId: msg.messageId,
    });
    this.eventHandler?.({
      type: "targets_updated",
      channelId: msg.channel,
    });

    return {
      route: await this.createTelegramRoute(config, msg),
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
    this.eventHandler?.({
      type: "discord_conversation_created",
      channelId: "discord",
      accountId: config.accountId,
      agentId: config.agentId,
      conversationId,
      defaultPermissionMode: config.defaultPermissionMode,
    });
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
      if (msg.chatType === "direct" || msg.isMention === true) {
        await adapter.sendDirectReply(
          msg.chatId,
          "This Discord bot isn't connected to a Letta agent yet.\n\n" +
            "Open Channels > Discord in Letta Code, choose which agent this bot should represent, and try again.",
        );
      }
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

    // In guild channels, only create routes from explicit mentions or
    // policy-permitted open-channel traffic.
    // Existing routed threads continue above via the route lookup path.
    if (msg.chatType === "channel" && !msg.isMention && !msg.isOpenChannel) {
      return null;
    }

    return {
      route: await this.createDiscordRoute(config, msg),
      isFirstRouteTurn: true,
    };
  }

  private async createWhatsAppRoute(
    config: WhatsAppChannelAccount,
    msg: InboundChannelMessage,
  ): Promise<ChannelRoute> {
    if (!config.agentId) {
      throw new Error("WhatsApp account is missing an agent binding.");
    }

    const conversationId = await this.createConversationForAgent(
      config.agentId,
      buildWhatsAppConversationSummary(msg),
    );
    const now = new Date().toISOString();
    const route: ChannelRoute = {
      accountId: config.accountId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      threadId: null,
      agentId: config.agentId,
      conversationId,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    addRoute(msg.channel, route);
    return route;
  }

  private async ensureWhatsAppRoute(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    config: WhatsAppChannelAccount,
  ): Promise<{
    route: ChannelRoute;
    isFirstRouteTurn: boolean;
  } | null> {
    if (!config.agentId) {
      if (msg.chatType !== "channel" || msg.isMention) {
        await adapter.sendDirectReply(
          msg.chatId,
          "This WhatsApp account isn't connected to a Letta agent yet.\n\n" +
            "Open Channels > WhatsApp in Letta Code, choose which agent this WhatsApp account should represent, and try again.",
        );
      }
      return null;
    }

    if (
      msg.chatType === "direct" &&
      config.dmPolicy === "allowlist" &&
      !allowedUsersIncludes(config.allowedUsers, msg.senderId)
    ) {
      await adapter.sendDirectReply(
        msg.chatId,
        "You are not on the allowed users list for this WhatsApp account.",
      );
      return null;
    }

    const accountId = msg.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    let route = getRouteFromStore(msg.channel, msg.chatId, accountId, null);
    if (!route) {
      loadRoutes(msg.channel);
      route = getRouteFromStore(msg.channel, msg.chatId, accountId, null);
    }

    if (route) {
      return { route, isFirstRouteTurn: false };
    }

    if (msg.chatType === "channel") {
      const now = new Date().toISOString();
      loadTargetStore(msg.channel);
      upsertChannelTarget(msg.channel, {
        accountId,
        targetId: msg.chatId,
        targetType: "channel",
        chatId: msg.chatId,
        label: msg.chatLabel ?? `WhatsApp group ${msg.chatId}`,
        discoveredAt: now,
        lastSeenAt: now,
        lastMessageId: msg.messageId,
      });
      this.eventHandler?.({
        type: "targets_updated",
        channelId: msg.channel,
      });
    }

    return {
      route: await this.createWhatsAppRoute(config, msg),
      isFirstRouteTurn: true,
    };
  }

  private async createSignalRoute(
    config: SignalChannelAccount,
    msg: InboundChannelMessage,
  ): Promise<ChannelRoute> {
    if (!config.agentId) {
      throw new Error("Signal account is missing an agent binding.");
    }

    const conversationId = await this.createConversationForAgent(
      config.agentId,
      buildSignalConversationSummary(msg),
    );
    const now = new Date().toISOString();
    const route: ChannelRoute = {
      accountId: config.accountId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      threadId: null,
      agentId: config.agentId,
      conversationId,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    addRoute(msg.channel, route);
    return route;
  }

  private async ensureSignalRoute(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    config: SignalChannelAccount,
  ): Promise<{
    route: ChannelRoute;
    isFirstRouteTurn: boolean;
  } | null> {
    if (!config.agentId) {
      if (!msg.reaction && (msg.chatType !== "channel" || msg.isMention)) {
        await adapter.sendDirectReply(
          msg.chatId,
          "This Signal account isn't connected to a Letta agent yet.\n\n" +
            "Open Channels > Signal in Letta Code, choose which agent this Signal account should represent, and try again.",
        );
      }
      return null;
    }

    if (
      msg.chatType === "direct" &&
      config.dmPolicy === "allowlist" &&
      !signalAllowedUsersIncludes(config.allowedUsers, msg.senderId)
    ) {
      if (!msg.reaction) {
        await adapter.sendDirectReply(
          msg.chatId,
          "You are not on the allowed users list for this Signal account.",
        );
      }
      return null;
    }

    const accountId = msg.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    let route = getRouteFromStore(msg.channel, msg.chatId, accountId, null);
    if (!route) {
      loadRoutes(msg.channel);
      route = getRouteFromStore(msg.channel, msg.chatId, accountId, null);
    }

    if (route) {
      return { route, isFirstRouteTurn: false };
    }

    if (msg.chatType === "channel") {
      const now = new Date().toISOString();
      loadTargetStore(msg.channel);
      upsertChannelTarget(msg.channel, {
        accountId,
        targetId: msg.chatId,
        targetType: "channel",
        chatId: msg.chatId,
        label: msg.chatLabel ?? `Signal group ${msg.chatId}`,
        discoveredAt: now,
        lastSeenAt: now,
        lastMessageId: msg.messageId,
      });
      this.eventHandler?.({
        type: "targets_updated",
        channelId: msg.channel,
      });
    }

    return {
      route: await this.createSignalRoute(config, msg),
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
  options?: {
    failOnStartupError?: boolean;
    logger?: ChannelStartupLogger;
    restoreAgentScope?: ChannelRestoreAgentScope | null;
  },
): Promise<ChannelRegistry> {
  const registry = ensureChannelRegistry();
  const failures: ChannelStartupFailure[] = [];

  logChannelStartup(
    options?.logger,
    `requested: ${channelNames.length > 0 ? channelNames.join(",") : "none"}`,
  );
  logChannelStartup(options?.logger, `root: ${getChannelsRoot()}`);

  // Eagerly hydrate/migrate channel account secrets at channel subsystem
  // startup. This converts existing plaintext token fields in accounts.json to
  // keyring-backed refs when the active credential store is `keyring` (or
  // `auto` with keyring available), while preserving file-mode compatibility.
  for (const channelId of new Set([
    ...getSupportedChannelIds(),
    ...channelNames,
  ])) {
    await hydrateChannelAccountSecrets(channelId);
  }

  for (const channelId of channelNames) {
    logChannelStartup(
      options?.logger,
      `loading ${channelId} accounts from ${getChannelAccountsPath(channelId)}`,
    );
    await hydrateChannelAccountSecrets(channelId);
    const accounts = listChannelAccounts(channelId);
    const restorableAccounts = accounts.filter(
      (account) =>
        account.enabled &&
        shouldRestoreChannelAccountForAgentScope(
          account,
          options?.restoreAgentScope,
        ),
    );
    const enabledAccountIds = restorableAccounts.map(
      (account) => account.accountId,
    );
    logChannelStartup(
      options?.logger,
      `${channelId}: accounts=${accounts.length}, enabled=${enabledAccountIds.length > 0 ? enabledAccountIds.join(",") : "none"}`,
    );
    if (accounts.length === 0) {
      const error = `Channel "${channelId}" not configured. Run: letta channels configure ${channelId}`;
      failures.push({ channelId, error });
      console.error(error);
      continue;
    }

    if (enabledAccountIds.length === 0) {
      const scopeSuffix = options?.restoreAgentScope
        ? ` in ${options.restoreAgentScope} restore scope`
        : "";
      const error = `Channel "${channelId}" has no enabled accounts${scopeSuffix}.`;
      failures.push({ channelId, error });
      console.error(error);
      logChannelStartup(options?.logger, error);
      continue;
    }

    if (channelId === "signal") {
      const conflict = findSignalBaseUrlConflict(
        accounts.filter(isSignalChannelAccount),
      );
      if (conflict) {
        const error = buildSignalBaseUrlConflictError(conflict);
        failures.push({ channelId, error });
        console.error(error);
        logChannelStartup(options?.logger, error);
        continue;
      }
    }

    for (const account of restorableAccounts) {
      try {
        await registry.startChannelAccount(channelId, account.accountId, {
          logger: options?.logger,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({
          channelId,
          accountId: account.accountId,
          error: message,
        });
        console.error(
          `[Channels] Failed to start ${channelId}/${account.accountId}:`,
          message,
        );
        logChannelStartup(
          options?.logger,
          `failed ${channelId}/${account.accountId}: ${formatChannelStartupError(error)}`,
        );
      }
    }
  }

  if (failures.length > 0 && options?.failOnStartupError) {
    await registry.stopAll();
    throw new ChannelInitializationError(failures);
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
