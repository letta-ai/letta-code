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

import { readChannelConfig } from "./config";
import {
  consumePairingCode,
  createPairingCode,
  isUserApproved,
  loadPairingStore,
  rollbackPairingApproval,
} from "./pairing";
import {
  addRoute,
  getRoute as getRouteFromStore,
  getRouteRaw,
  loadRoutes,
  removeRouteInMemory,
  setRouteInMemory,
} from "./routing";
import type {
  ChannelAdapter,
  ChannelRoute,
  InboundChannelMessage,
} from "./types";
import { formatChannelNotification } from "./xml";

// ── Singleton ─────────────────────────────────────────────────────

let instance: ChannelRegistry | null = null;

export function getChannelRegistry(): ChannelRegistry | null {
  return instance;
}

export function getActiveChannelIds(): string[] {
  if (!instance) return [];
  return instance.getActiveChannelIds();
}

// ── Types ─────────────────────────────────────────────────────────

export type ChannelMessageHandler = (
  route: ChannelRoute,
  xmlContent: string,
) => void;

// ── Registry ──────────────────────────────────────────────────────

export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private ready = false;
  private messageHandler: ChannelMessageHandler | null = null;
  private readonly buffer: Array<{
    route: ChannelRoute;
    xmlContent: string;
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
      if (!isUserApproved(msg.channel, msg.senderId)) {
        // Generate pairing code
        const code = createPairingCode(
          msg.channel,
          msg.senderId,
          msg.chatId,
          msg.senderName,
        );
        await adapter.sendDirectReply(
          msg.chatId,
          `To connect this chat to a Letta Code agent, run:\n\n` +
            `/channels telegram pair ${code}\n\n` +
            `This code expires in 15 minutes.`,
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
        `This chat isn't bound to an agent. ` +
          `Run \`/channels telegram enable --chat-id ${msg.chatId}\` ` +
          `on your Letta Code agent to connect.`,
      );
      return;
    }

    // 3. Format as XML
    const xmlContent = formatChannelNotification(msg);

    // 4. Deliver or buffer
    if (this.isReady()) {
      this.messageHandler?.(route, xmlContent);
    } else {
      this.buffer.push({ route, xmlContent });
    }
  }

  private flushBuffer(): void {
    if (!this.messageHandler) return;

    while (this.buffer.length > 0) {
      const item = this.buffer.shift();
      if (item) {
        this.messageHandler(item.route, item.xmlContent);
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
  const registry = new ChannelRegistry();

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

    // Load persistent state
    loadRoutes(channelId);
    loadPairingStore(channelId);

    // Create and register adapter
    if (channelId === "telegram") {
      const { createTelegramAdapter } = await import("./telegram/adapter");
      const adapter = createTelegramAdapter(config);
      registry.registerAdapter(adapter);
    } else {
      console.error(`Unknown channel: "${channelId}". Supported: telegram`);
    }
  }

  // Start all adapters (begin receiving, buffer until ready)
  await registry.startAll();

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
