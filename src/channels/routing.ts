/**
 * Channel routing table.
 *
 * Maps platform chat IDs to Letta agent+conversation pairs.
 * Persisted in ~/.letta/channels/<channel>/routing.yaml.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getChannelDir, getChannelRoutingPath } from "./config";
import type { ChannelRoute } from "./types";

// ── In-memory store ───────────────────────────────────────────────

/** Key: "channel:chatId" */
const routesByKey = new Map<string, ChannelRoute>();

function routeKey(channel: string, chatId: string): string {
  return `${channel}:${chatId}`;
}

// ── Load/save ─────────────────────────────────────────────────────

/**
 * Load routing table from disk for a given channel.
 */
export function loadRoutes(channelId: string): void {
  const path = getChannelRoutingPath(channelId);
  if (!existsSync(path)) return;

  try {
    const text = readFileSync(path, "utf-8");
    const parsed = JSON.parse(text) as { routes?: ChannelRoute[] };
    const routes = parsed.routes ?? [];

    for (const route of routes) {
      if (route.chatId && route.agentId && route.conversationId) {
        routesByKey.set(routeKey(channelId, route.chatId), {
          chatId: route.chatId,
          agentId: route.agentId,
          conversationId: route.conversationId,
          enabled: route.enabled !== false,
          createdAt: route.createdAt ?? new Date().toISOString(),
        });
      }
    }
  } catch {
    // Corrupted file — start fresh.
  }
}

// Test hook: when set, saveRoutes calls this instead of writing to disk.
let saveRoutesOverride: ((channelId: string) => void) | null = null;

/** @internal Test-only: override saveRoutes behavior. Pass null to restore. */
export function __testOverrideSaveRoutes(
  fn: ((channelId: string) => void) | null,
): void {
  saveRoutesOverride = fn;
}

/**
 * Save all routes for a given channel to disk.
 */
export function saveRoutes(channelId: string): void {
  if (saveRoutesOverride) {
    saveRoutesOverride(channelId);
    return;
  }

  const dir = getChannelDir(channelId);
  mkdirSync(dir, { recursive: true });

  const routes = getRoutesForChannel(channelId);
  const data = { routes };
  writeFileSync(
    getChannelRoutingPath(channelId),
    `${JSON.stringify(data, null, 2)}\n`,
    "utf-8",
  );
}

// ── Lookup ────────────────────────────────────────────────────────

/**
 * Get the route for a specific channel + chatId.
 * Returns null if no route exists or the route is disabled.
 */
export function getRoute(channel: string, chatId: string): ChannelRoute | null {
  const route = routesByKey.get(routeKey(channel, chatId));
  if (!route || !route.enabled) return null;
  return route;
}

/**
 * Get the raw route entry (including disabled), or undefined.
 * Used for snapshotting before an overwrite.
 */
export function getRouteRaw(
  channel: string,
  chatId: string,
): ChannelRoute | undefined {
  return routesByKey.get(routeKey(channel, chatId));
}

/**
 * Get all routes for a channel.
 */
export function getRoutesForChannel(channelId: string): ChannelRoute[] {
  const prefix = `${channelId}:`;
  const routes: ChannelRoute[] = [];
  for (const [key, route] of routesByKey) {
    if (key.startsWith(prefix)) {
      routes.push(route);
    }
  }
  return routes;
}

/**
 * Get all routes across all channels.
 */
export function getAllRoutes(): ChannelRoute[] {
  return Array.from(routesByKey.values());
}

// ── Mutations ─────────────────────────────────────────────────────

/**
 * Add or update a route. Automatically saves to disk.
 */
export function addRoute(channelId: string, route: ChannelRoute): void {
  routesByKey.set(routeKey(channelId, route.chatId), route);
  saveRoutes(channelId);
}

/**
 * Remove a route. Automatically saves to disk.
 */
export function removeRoute(channelId: string, chatId: string): boolean {
  const key = routeKey(channelId, chatId);
  const existed = routesByKey.delete(key);
  if (existed) {
    saveRoutes(channelId);
  }
  return existed;
}

/**
 * Remove a route from the in-memory map only (no disk write).
 * Used by rollback paths where the original disk write already failed.
 */
export function removeRouteInMemory(
  channelId: string,
  chatId: string,
): boolean {
  return routesByKey.delete(routeKey(channelId, chatId));
}

/**
 * Set a route in the in-memory map only (no disk write).
 * Used to restore a snapshot on rollback.
 */
export function setRouteInMemory(channelId: string, route: ChannelRoute): void {
  routesByKey.set(routeKey(channelId, route.chatId), route);
}

/**
 * Remove all routes for a specific agent+conversation.
 * Used when disabling channels for an agent.
 */
export function removeRoutesForScope(
  channelId: string,
  agentId: string,
  conversationId: string,
): number {
  let removed = 0;
  const prefix = `${channelId}:`;
  for (const [key, route] of routesByKey) {
    if (
      key.startsWith(prefix) &&
      route.agentId === agentId &&
      route.conversationId === conversationId
    ) {
      routesByKey.delete(key);
      removed++;
    }
  }
  if (removed > 0) {
    saveRoutes(channelId);
  }
  return removed;
}

/**
 * Clear all in-memory routes (for testing).
 */
export function clearAllRoutes(): void {
  routesByKey.clear();
}
