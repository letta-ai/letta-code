/**
 * Channel Registry — singleton that manages channel adapters, routing,
 * pairing, and the ingress pipeline.
 *
 * Lifecycle:
 * 1. initializeChannels() creates adapters from configs
 * 2. Adapters start long-polling (buffer inbound until ready)
 * 3. setReady() is called from inside startListenerClient() once closure state exists
 * 4. Buffered messages flush through the registered onMessage handler
 */

import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { readChannelConfig } from "./config";
import {
  consumePairingCode,
  createPairingCode,
  isUserApproved,
  loadPairingStore,
  rollbackPairingApproval,
} from "./pairing";
import { loadChannelPlugin } from "./pluginRegistry";
import {
  addRoute,
  getRoute as getRouteFromStore,
  getRouteRaw,
  loadRoutes,
  removeRouteInMemory,
  setRouteInMemory,
} from "./routing";
import { loadTargetStore, upsertChannelTarget } from "./targets";
import type {
  ChannelAdapter,
  ChannelRoute,
  InboundChannelMessage,
} from "./types";
import { formatChannelNotification } from "./xml";

function buildPairingInstructions(channelId: string, code: string): string {
  return (
    `To connect this chat to a Letta Code agent, run:\n\n` +
    `/channels ${channelId} pair ${code}\n\n` +
    `This code expires in 15 minutes.`
  );
}

function buildUnboundRouteInstructions(
  channelId: string,
  chatId: string,
): string {
  return (
    `This chat isn't bound to an agent. ` +
    `Run \`/channels ${channelId} enable --chat-id ${chatId}\` ` +
    `on your Letta Code agent to connect.`
  );
}

function buildSlackTargetInstructions(): string {
  return (
    "This Slack channel isn't connected to an agent yet.\n\n" +
    "Open Channels > Slack > Connections in Letta Code to bind this channel, " +
    "then mention the bot again."
  );
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

export type ChannelMessageHandler = (
  route: ChannelRoute,
  content: MessageCreate["content"],
) => void;

export type ChannelRegistryEvent =
  | {
      type: "pairings_updated";
      channelId: string;
    }
  | {
      type: "targets_updated";
      channelId: string;
    };

// ── Registry ──────────────────────────────────────────────────────

export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private ready = false;
  private messageHandler: ChannelMessageHandler | null = null;
  private eventHandler: ((event: ChannelRegistryEvent) => void) | null = null;
  private readonly buffer: Array<{
    route: ChannelRoute;
    content: MessageCreate["content"];
  }> = [];

  constructor() {
    if (instance) {
      throw new Error(
        "ChannelRegistry is a singleton — use getChannelRegistry()",
      );
    }
    instance = this;
  }

  // ── Adapter management ────────────────────────────────────────

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.id, adapter);

    // Wire the adapter's onMessage to our ingress pipeline
    adapter.onMessage = async (msg: InboundChannelMessage) => {
      await this.handleInboundMessage(msg);
    };
  }

  getAdapter(channelId: string): ChannelAdapter | null {
    return this.adapters.get(channelId) ?? null;
  }

  getActiveChannelIds(): string[] {
    return Array.from(this.adapters.entries())
      .filter(([_, adapter]) => adapter.isRunning())
      .map(([id]) => id);
  }

  // ── Readiness / ingress handler ───────────────────────────────

  /**
   * Set the message handler and mark the registry as ready.
   * Called from inside startListenerClient() with closure-scoped state.
   */
  setMessageHandler(handler: ChannelMessageHandler): void {
    this.messageHandler = handler;
  }

  setEventHandler(
    handler: ((event: ChannelRegistryEvent) => void) | null,
  ): void {
    this.eventHandler = handler;
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

  getRoute(channel: string, chatId: string): ChannelRoute | null {
    return getRouteFromStore(channel, chatId);
  }

  async startChannel(channelId: string): Promise<boolean> {
    const config = readChannelConfig(channelId);
    if (!config) {
      return false;
    }

    loadRoutes(channelId);
    loadPairingStore(channelId);
    loadTargetStore(channelId);

    const existing = this.adapters.get(channelId);
    if (existing?.isRunning()) {
      await existing.stop();
    }
    this.adapters.delete(channelId);

    const plugin = await loadChannelPlugin(config.channel);
    const adapter = await plugin.createAdapter(config);
    this.registerAdapter(adapter);
    await adapter.start();
    return true;
  }

  async stopChannel(channelId: string): Promise<boolean> {
    const adapter = this.adapters.get(channelId);
    if (!adapter) {
      return false;
    }
    if (adapter.isRunning()) {
      await adapter.stop();
    }
    this.adapters.delete(channelId);
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
    instance = null;
  }

  // ── Inbound message pipeline ──────────────────────────────────

  private async handleInboundMessage(
    msg: InboundChannelMessage,
  ): Promise<void> {
    const adapter = this.getAdapter(msg.channel);
    if (!adapter) return;

    const config = readChannelConfig(msg.channel);
    if (!config) return;

    if (msg.channel === "slack" && msg.chatType === "channel") {
      await this.handleSlackChannelMessage(adapter, msg);
      return;
    }

    // 1. Check pairing/allowlist policy
    if (config.dmPolicy === "allowlist") {
      if (!config.allowedUsers.includes(msg.senderId)) {
        await adapter.sendDirectReply(
          msg.chatId,
          "You are not on the allowed users list for this bot.",
        );
        return;
      }
    } else if (config.dmPolicy === "pairing") {
      // Reload pairing store from disk on miss (allows standalone CLI pairing)
      if (!isUserApproved(msg.channel, msg.senderId)) {
        loadPairingStore(msg.channel);
      }
      if (!isUserApproved(msg.channel, msg.senderId)) {
        // Generate pairing code
        const code = createPairingCode(
          msg.channel,
          msg.senderId,
          msg.chatId,
          msg.senderName,
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
    let route = getRouteFromStore(msg.channel, msg.chatId);
    if (!route) {
      loadRoutes(msg.channel);
      route = getRouteFromStore(msg.channel, msg.chatId);
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
    this.deliverOrBuffer(route, content);
  }

  private async handleSlackChannelMessage(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
  ): Promise<void> {
    let route = getRouteFromStore(msg.channel, msg.chatId);
    if (!route) {
      loadRoutes(msg.channel);
      route = getRouteFromStore(msg.channel, msg.chatId);
    }

    if (!route) {
      const now = new Date().toISOString();
      loadTargetStore(msg.channel);
      upsertChannelTarget(msg.channel, {
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
      await adapter.sendDirectReply(
        msg.chatId,
        buildSlackTargetInstructions(),
        msg.messageId ? { replyToMessageId: msg.messageId } : undefined,
      );
      return;
    }

    this.deliverOrBuffer(route, formatChannelNotification(msg));
  }

  private deliverOrBuffer(
    route: ChannelRoute,
    content: MessageCreate["content"],
  ): void {
    if (this.isReady()) {
      this.messageHandler?.(route, content);
      return;
    }

    this.buffer.push({ route, content });
  }

  private flushBuffer(): void {
    if (!this.messageHandler) return;

    while (this.buffer.length > 0) {
      const item = this.buffer.shift();
      if (item) {
        this.messageHandler(item.route, item.content);
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
    const config = readChannelConfig(channelId);
    if (!config) {
      console.error(
        `Channel "${channelId}" not configured. Run: letta channels configure ${channelId}`,
      );
      continue;
    }

    if (!config.enabled) {
      console.log(`Channel "${channelId}" is disabled in config, skipping.`);
      continue;
    }

    try {
      await registry.startChannel(channelId);
    } catch (error) {
      console.error(
        `[Channels] Failed to start ${channelId}:`,
        error instanceof Error ? error.message : error,
      );
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
): { success: boolean; error?: string; chatId?: string } {
  const pending = consumePairingCode(channelId, code);
  if (!pending) {
    return { success: false, error: "Invalid or expired pairing code." };
  }

  // Snapshot existing route so we can restore it on failure
  const previousRoute = getRouteRaw(channelId, pending.chatId);

  // Create route — roll back pairing approval AND in-memory route if this fails
  try {
    addRoute(channelId, {
      chatId: pending.chatId,
      agentId,
      conversationId,
      enabled: true,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    // Restore in-memory route to prior state (no disk write — disk is what failed)
    if (previousRoute) {
      setRouteInMemory(channelId, previousRoute);
    } else {
      removeRouteInMemory(channelId, pending.chatId);
    }
    // Roll back: re-add the pending code and remove the approved user
    rollbackPairingApproval(channelId, pending);
    const msg = err instanceof Error ? err.message : "unknown error";
    return {
      success: false,
      error: `Pairing approved but route creation failed (rolled back): ${msg}`,
    };
  }

  return { success: true, chatId: pending.chatId };
}
