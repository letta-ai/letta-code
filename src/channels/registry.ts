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

import {
  getChannelAccountWithSecrets,
  hydrateChannelAccountSecrets,
  LEGACY_CHANNEL_ACCOUNT_ID,
  listChannelAccounts,
  listChannelAccountsWithSecrets,
} from "./accounts";
import { getChannelAccountsPath, getChannelsRoot } from "./config";
import {
  consumePairingCode,
  loadPairingStore,
  rollbackPairingApproval,
} from "./pairing";
import { getSupportedChannelIds, loadChannelPlugin } from "./plugin-registry";
import {
  type ChannelCommandRouter,
  createChannelCommandRouter,
} from "./registry-commands";
import {
  type ChannelApprovalResponseHandler,
  ChannelControlRequests,
  type PendingChannelControlRequest,
} from "./registry-controls";
import type { ChannelRegistryEvent } from "./registry-events";
import type {
  ChannelCancelHandler,
  ChannelInboundDelivery,
  ChannelMessageHandler,
  ChannelModelHandler,
  ChannelReflectionHandler,
  ChannelReloadHandler,
} from "./registry-handlers";
import {
  type ChannelInboundRouter,
  createChannelInboundRouter,
} from "./registry-inbound";
import {
  type ChannelRouteProvisioner,
  createChannelRouteProvisioner,
} from "./registry-routes";
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
import {
  buildSignalBaseUrlConflictError,
  findSignalBaseUrlConflict,
  findSignalBaseUrlConflictForStart,
} from "./signal/account-conflicts";
import { loadTargetStore } from "./targets";
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
  ChannelRoute,
  ChannelStartupLogger,
  ChannelTurnLifecycleEvent,
  ChannelTurnProgressEvent,
  ChannelTurnSource,
  InboundChannelMessage,
} from "./types";
import { isSignalChannelAccount } from "./types";
import { subscribeWhatsAppConnectionState } from "./whatsapp/state";

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
  private reloadHandler: ChannelReloadHandler | null = null;
  private readonly buffer: ChannelInboundDelivery[] = [];
  private readonly controls: ChannelControlRequests;
  private readonly routes: ChannelRouteProvisioner;
  private readonly commands: ChannelCommandRouter;
  private readonly inbound: ChannelInboundRouter;
  private readonly unsubscribeWhatsAppState: () => void;

  constructor() {
    if (instance) {
      throw new Error(
        "ChannelRegistry is a singleton — use getChannelRegistry()",
      );
    }
    instance = this;
    this.controls = new ChannelControlRequests({
      getAdapter: (channelId, accountId) =>
        this.getAdapter(channelId, accountId),
      getApprovalResponseHandler: () => this.approvalResponseHandler,
    });
    this.routes = createChannelRouteProvisioner({
      emitEvent: (event) => this.eventHandler?.(event),
    });
    this.commands = createChannelCommandRouter({
      routes: this.routes,
      emitEvent: (event) => this.eventHandler?.(event),
      getRoute: (channel, chatId, accountId, threadId) =>
        this.getRoute(channel, chatId, accountId, threadId),
      getCancelHandler: () => this.cancelHandler,
      getReflectionHandler: () => this.reflectionHandler,
      getReloadHandler: () => this.reloadHandler,
      getModelHandler: () => this.modelHandler,
    });
    this.inbound = createChannelInboundRouter({
      controls: this.controls,
      commands: this.commands,
      routes: this.routes,
      getAdapter: (channelId, accountId) =>
        this.getAdapter(channelId, accountId),
      dispatchTurnLifecycleEvent: (event) =>
        this.dispatchTurnLifecycleEvent(event),
      deliver: (delivery) => this.deliverOrBuffer(delivery),
      emitEvent: (event) => this.eventHandler?.(event),
    });
    this.unsubscribeWhatsAppState = subscribeWhatsAppConnectionState(
      (accountId) => {
        this.eventHandler?.({
          type: "channel_account_state_updated",
          channelId: "whatsapp",
          accountId,
        });
      },
    );
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
      await this.inbound.handleInboundMessage(msg);
    };
    adapter.onControlResponse = async (input) =>
      await this.controls.handleNativeResponse(input);
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

  resolveTurnSourcesForScope(
    agentId: string,
    conversationId: string,
  ): ChannelTurnSource[] {
    const sources: ChannelTurnSource[] = [];
    const seen = new Set<string>();
    for (const adapter of this.adapters.values()) {
      const channel = adapter.channelId ?? adapter.id;
      const accountId = adapter.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
      for (const route of getRoutesForChannel(channel, accountId)) {
        if (
          route.enabled === false ||
          route.agentId !== agentId ||
          route.conversationId !== conversationId
        ) {
          continue;
        }
        const key = `${channel}:${accountId}:${route.chatId}:${route.threadId ?? ""}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        sources.push({
          channel,
          accountId,
          chatId: route.chatId,
          chatType: route.chatType,
          threadId: route.threadId ?? null,
          agentId,
          conversationId,
        });
      }
    }
    return sources;
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

  setReloadHandler(handler: ChannelReloadHandler | null): void {
    this.reloadHandler = handler;
  }

  setEventHandler(
    handler: ((event: ChannelRegistryEvent) => void) | null,
  ): void {
    this.eventHandler = handler;
  }

  hasPendingControlRequest(requestId: string): boolean {
    return this.controls.has(requestId);
  }

  getPendingControlRequests(): PendingChannelControlRequest[] {
    return this.controls.getAll();
  }

  async registerPendingControlRequest(
    event: ChannelControlRequestEvent,
  ): Promise<void> {
    await this.controls.register(event);
  }

  async redeliverPendingControlRequest(requestId: string): Promise<boolean> {
    return this.controls.redeliver(requestId);
  }

  clearPendingControlRequest(requestId: string): void {
    this.controls.clear(requestId);
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
    this.reloadHandler = null;
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
    this.reloadHandler = null;
    this.controls.clearAll();
    this.unsubscribeWhatsAppState();
    instance = null;
  }

  // ── Inbound message pipeline ──────────────────────────────────

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
