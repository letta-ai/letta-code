import { readChannelConfig, writeChannelConfig } from "./config";
import {
  getApprovedUsers,
  getPendingPairings,
  loadPairingStore,
} from "./pairing";
import {
  completePairing,
  ensureChannelRegistry,
  getChannelRegistry,
  initializeChannels,
} from "./registry";
import {
  getRoute,
  getRoutesForChannel,
  loadRoutes,
  removeRoute,
} from "./routing";
import type {
  ChannelConfig,
  ChannelRoute,
  DmPolicy,
  SupportedChannelId,
  TelegramChannelConfig,
} from "./types";

export const CHANNEL_DISPLAY_NAMES: Record<SupportedChannelId, string> = {
  telegram: "Telegram",
};

export interface ChannelSummary {
  channelId: SupportedChannelId;
  displayName: string;
  configured: boolean;
  enabled: boolean;
  running: boolean;
  dmPolicy: DmPolicy | null;
  pendingPairingsCount: number;
  approvedUsersCount: number;
  routesCount: number;
}

export interface ChannelConfigSnapshot {
  channelId: SupportedChannelId;
  enabled: boolean;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
  hasToken: boolean;
}

export interface PendingPairingSnapshot {
  code: string;
  senderId: string;
  senderName?: string;
  chatId: string;
  createdAt: string;
  expiresAt: string;
}

export interface ChannelRouteSnapshot {
  channelId: SupportedChannelId;
  chatId: string;
  agentId: string;
  conversationId: string;
  enabled: boolean;
  createdAt: string;
}

export interface ChannelConfigPatch {
  token?: string;
  dmPolicy?: DmPolicy;
  allowedUsers?: string[];
}

function assertSupportedChannelId(
  channelId: string,
): asserts channelId is SupportedChannelId {
  if (channelId !== "telegram") {
    throw new Error(`Unsupported channel: ${channelId}`);
  }
}

function toConfigSnapshot(
  channelId: SupportedChannelId,
  config: ChannelConfig,
): ChannelConfigSnapshot {
  return {
    channelId,
    enabled: config.enabled,
    dmPolicy: config.dmPolicy,
    allowedUsers: [...config.allowedUsers],
    hasToken: config.token.trim().length > 0,
  };
}

function toPendingPairingSnapshot(pending: {
  code: string;
  telegramUserId: string;
  telegramUsername?: string;
  chatId: string;
  createdAt: string;
  expiresAt: string;
}): PendingPairingSnapshot {
  return {
    code: pending.code,
    senderId: pending.telegramUserId,
    senderName: pending.telegramUsername,
    chatId: pending.chatId,
    createdAt: pending.createdAt,
    expiresAt: pending.expiresAt,
  };
}

function toRouteSnapshot(
  channelId: SupportedChannelId,
  route: ChannelRoute,
): ChannelRouteSnapshot {
  return {
    channelId,
    chatId: route.chatId,
    agentId: route.agentId,
    conversationId: route.conversationId,
    enabled: route.enabled,
    createdAt: route.createdAt,
  };
}

export function listChannelSummaries(): ChannelSummary[] {
  const registry = getChannelRegistry();
  const channelId = "telegram" as const;
  const config = readChannelConfig(channelId);

  if (!config) {
    return [
      {
        channelId,
        displayName: CHANNEL_DISPLAY_NAMES[channelId],
        configured: false,
        enabled: false,
        running: false,
        dmPolicy: null,
        pendingPairingsCount: 0,
        approvedUsersCount: 0,
        routesCount: 0,
      },
    ];
  }

  loadRoutes(channelId);
  loadPairingStore(channelId);

  return [
    {
      channelId,
      displayName: CHANNEL_DISPLAY_NAMES[channelId],
      configured: true,
      enabled: config.enabled,
      running: registry?.getAdapter(channelId)?.isRunning() ?? false,
      dmPolicy: config.dmPolicy,
      pendingPairingsCount: getPendingPairings(channelId).length,
      approvedUsersCount: getApprovedUsers(channelId).length,
      routesCount: getRoutesForChannel(channelId).length,
    },
  ];
}

export function getChannelConfigSnapshot(
  channelId: string,
): ChannelConfigSnapshot | null {
  assertSupportedChannelId(channelId);
  const config = readChannelConfig(channelId);
  if (!config) {
    return null;
  }
  return toConfigSnapshot(channelId, config);
}

export async function setChannelConfigLive(
  channelId: string,
  patch: ChannelConfigPatch,
): Promise<ChannelConfigSnapshot> {
  assertSupportedChannelId(channelId);

  const existing = readChannelConfig(channelId);
  const merged: TelegramChannelConfig = {
    channel: "telegram",
    enabled: existing?.enabled ?? false,
    token: patch.token ?? existing?.token ?? "",
    dmPolicy: patch.dmPolicy ?? existing?.dmPolicy ?? "pairing",
    allowedUsers: patch.allowedUsers ?? existing?.allowedUsers ?? [],
  };

  writeChannelConfig(channelId, merged);

  if (merged.enabled) {
    const registry = ensureChannelRegistry();
    await registry.startChannel(channelId);
  }

  return toConfigSnapshot(channelId, merged);
}

export async function startChannelLive(
  channelId: string,
): Promise<ChannelSummary> {
  assertSupportedChannelId(channelId);

  const existing = readChannelConfig(channelId);
  if (!existing) {
    throw new Error(
      `Channel "${channelId}" is not configured. Configure it first.`,
    );
  }
  if (!existing.token.trim()) {
    throw new Error(
      `Channel "${channelId}" is missing a token. Configure it first.`,
    );
  }

  if (!existing.enabled) {
    writeChannelConfig(channelId, {
      ...existing,
      enabled: true,
    });
  }

  if (!getChannelRegistry()) {
    await initializeChannels([channelId]);
  } else {
    await ensureChannelRegistry().startChannel(channelId);
  }

  const summary = listChannelSummaries().find(
    (entry) => entry.channelId === channelId,
  );
  if (!summary) {
    throw new Error(`Channel "${channelId}" summary not found after start`);
  }
  return summary;
}

export async function stopChannelLive(
  channelId: string,
): Promise<ChannelSummary> {
  assertSupportedChannelId(channelId);

  const existing = readChannelConfig(channelId);
  if (!existing) {
    throw new Error(
      `Channel "${channelId}" is not configured. Configure it first.`,
    );
  }

  writeChannelConfig(channelId, {
    ...existing,
    enabled: false,
  });

  await getChannelRegistry()?.stopChannel(channelId);

  const summary = listChannelSummaries().find(
    (entry) => entry.channelId === channelId,
  );
  if (!summary) {
    throw new Error(`Channel "${channelId}" summary not found after stop`);
  }
  return summary;
}

export function listPendingPairingSnapshots(
  channelId: string,
): PendingPairingSnapshot[] {
  assertSupportedChannelId(channelId);
  loadPairingStore(channelId);
  return getPendingPairings(channelId).map(toPendingPairingSnapshot);
}

export function bindChannelPairing(
  channelId: string,
  code: string,
  agentId: string,
  conversationId: string,
): { chatId: string; route: ChannelRouteSnapshot } {
  assertSupportedChannelId(channelId);
  loadRoutes(channelId);
  loadPairingStore(channelId);

  const result = completePairing(channelId, code, agentId, conversationId);
  if (!result.success || !result.chatId) {
    throw new Error(result.error ?? "Failed to bind pairing");
  }

  const route = getRoute(channelId, result.chatId);
  if (!route) {
    throw new Error("Pairing succeeded but route was not found");
  }

  return {
    chatId: result.chatId,
    route: toRouteSnapshot(channelId, route),
  };
}

export function listChannelRouteSnapshots(params?: {
  channelId?: string;
  agentId?: string;
  conversationId?: string;
}): ChannelRouteSnapshot[] {
  const channelId = (params?.channelId ?? "telegram") as string;
  assertSupportedChannelId(channelId);

  loadRoutes(channelId);

  return getRoutesForChannel(channelId)
    .filter((route) =>
      params?.agentId ? route.agentId === params.agentId : true,
    )
    .filter((route) =>
      params?.conversationId
        ? route.conversationId === params.conversationId
        : true,
    )
    .map((route) => toRouteSnapshot(channelId, route));
}

export function removeChannelRouteLive(
  channelId: string,
  chatId: string,
): boolean {
  assertSupportedChannelId(channelId);
  loadRoutes(channelId);
  return removeRoute(channelId, chatId);
}
