/**
 * Channel routing table.
 *
 * Maps platform chat IDs to Letta agent+conversation pairs.
 * Persisted in ~/.letta/channels/<channel>/routing.yaml.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { LEGACY_CHANNEL_ACCOUNT_ID } from "./accounts";
import { getChannelDir, getChannelRoutingPath } from "./config";
import type { ChannelRoute } from "./types";

// ── In-memory store ───────────────────────────────────────────────

/** Key: "channel:chatId" */
const routesByKey = new Map<string, ChannelRoute>();

let loadRoutesOverride: ((channelId: string) => ChannelRoute[] | null) | null =
  null;

function normalizeAccountId(accountId?: string): string {
  return accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
}

function normalizeThreadId(threadId?: string | null): string {
  const trimmed = threadId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "__root__";
}

function routeKey(
  channel: string,
  chatId: string,
  accountId?: string,
  threadId?: string | null,
): string {
  return `${channel}:${normalizeAccountId(accountId)}:${chatId}:${normalizeThreadId(threadId)}`;
}

// ── Load/save ─────────────────────────────────────────────────────

/**
 * Load routing table from disk for a given channel.
 */
export function loadRoutes(channelId: string): void {
  if (loadRoutesOverride) {
    const overriddenRoutes = loadRoutesOverride(channelId);
    if (overriddenRoutes === null) {
      return;
    }

    const prefix = `${channelId}:`;
    for (const key of Array.from(routesByKey.keys())) {
      if (key.startsWith(prefix)) {
        routesByKey.delete(key);
      }
    }

    for (const route of overriddenRoutes) {
      if (route.chatId && route.agentId && route.conversationId) {
        routesByKey.set(
          routeKey(channelId, route.chatId, route.accountId, route.threadId),
          {
            accountId: normalizeAccountId(route.accountId),
            chatId: route.chatId,
            chatType: route.chatType,
            threadId: route.threadId ?? null,
            agentId: route.agentId,
            conversationId: route.conversationId,
            enabled: route.enabled !== false,
            createdAt: route.createdAt ?? new Date().toISOString(),
            updatedAt:
              route.updatedAt ?? route.createdAt ?? new Date().toISOString(),
          },
        );
      }
    }
    return;
  }

  const path = getChannelRoutingPath(channelId);
  if (!existsSync(path)) return;

  try {
    const text = readFileSync(path, "utf-8");
    const parsed = JSON.parse(text) as { routes?: ChannelRoute[] };
    const routes = parsed.routes ?? [];

    for (const route of routes) {
      if (route.chatId && route.agentId && route.conversationId) {
        routesByKey.set(
          routeKey(channelId, route.chatId, route.accountId, route.threadId),
          {
            accountId: normalizeAccountId(route.accountId),
            chatId: route.chatId,
            chatType: route.chatType,
            threadId: route.threadId ?? null,
            agentId: route.agentId,
            conversationId: route.conversationId,
            enabled: route.enabled !== false,
            createdAt: route.createdAt ?? new Date().toISOString(),
            updatedAt:
              route.updatedAt ?? route.createdAt ?? new Date().toISOString(),
          },
        );
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

/** @internal Test-only: override loadRoutes behavior. Pass null to restore. */
export function __testOverrideLoadRoutes(
  fn: ((channelId: string) => ChannelRoute[] | null) | null,
): void {
  loadRoutesOverride = fn;
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
export function getRoute(
  channel: string,
  chatId: string,
  accountId?: string,
  threadId?: string | null,
): ChannelRoute | null {
  const route = routesByKey.get(routeKey(channel, chatId, accountId, threadId));
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
  accountId?: string,
  threadId?: string | null,
): ChannelRoute | undefined {
  return routesByKey.get(routeKey(channel, chatId, accountId, threadId));
}

/**
 * Get all routes for a channel.
 */
export function getRoutesForChannel(
  channelId: string,
  accountId?: string,
): ChannelRoute[] {
  const prefix =
    accountId === undefined
      ? `${channelId}:`
      : `${channelId}:${normalizeAccountId(accountId)}:`;
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
  routesByKey.set(
    routeKey(channelId, route.chatId, route.accountId, route.threadId),
    {
      ...route,
      accountId: normalizeAccountId(route.accountId),
      threadId: route.threadId ?? null,
    },
  );
  saveRoutes(channelId);
}

/**
 * Remove a route. Automatically saves to disk.
 */
export function removeRoute(
  channelId: string,
  chatId: string,
  accountId?: string,
  threadId?: string | null,
): boolean {
  const key = routeKey(channelId, chatId, accountId, threadId);
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
  accountId?: string,
  threadId?: string | null,
): boolean {
  return routesByKey.delete(routeKey(channelId, chatId, accountId, threadId));
}

/**
 * Set a route in the in-memory map only (no disk write).
 * Used to restore a snapshot on rollback.
 */
export function setRouteInMemory(channelId: string, route: ChannelRoute): void {
  routesByKey.set(
    routeKey(channelId, route.chatId, route.accountId, route.threadId),
    {
      ...route,
      accountId: normalizeAccountId(route.accountId),
      threadId: route.threadId ?? null,
    },
  );
}

/**
 * Remove all routes for a specific agent+conversation.
 * Used when disabling channels for an agent.
 */
export function removeRoutesForScope(
  channelId: string,
  agentId: string,
  conversationId: string,
  accountId?: string,
): number {
  let removed = 0;
  const prefix =
    accountId === undefined
      ? `${channelId}:`
      : `${channelId}:${normalizeAccountId(accountId)}:`;
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

export function removeRoutesForAccount(
  channelId: string,
  accountId: string,
): number {
  let removed = 0;
  const prefix = `${channelId}:${normalizeAccountId(accountId)}:`;
  for (const [key] of routesByKey) {
    if (key.startsWith(prefix)) {
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
