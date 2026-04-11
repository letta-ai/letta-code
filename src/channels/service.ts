import { readChannelConfig, writeChannelConfig } from "./config";
import {
  getApprovedUsers,
  getPendingPairings,
  loadPairingStore,
} from "./pairing";
import {
  getChannelDisplayName,
  getSupportedChannelIds,
  isSupportedChannelId,
} from "./pluginRegistry";
import {
  completePairing,
  ensureChannelRegistry,
  getChannelRegistry,
  initializeChannels,
} from "./registry";
import {
  addRoute,
  getRoute,
  getRoutesForChannel,
  loadRoutes,
  removeRoute,
} from "./routing";
import {
  getChannelTarget,
  listChannelTargets,
  loadTargetStore,
  removeChannelTarget,
} from "./targets";
import type {
  ChannelBindableTarget,
  ChannelConfig,
  ChannelRoute,
  DmPolicy,
  PendingPairing,
  SlackChannelConfig,
  SlackChannelMode,
  SupportedChannelId,
  TelegramChannelConfig,
} from "./types";

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

export type ChannelConfigSnapshot =
  | {
      channelId: "telegram";
      enabled: boolean;
      dmPolicy: DmPolicy;
      allowedUsers: string[];
      hasToken: boolean;
    }
  | {
      channelId: "slack";
      enabled: boolean;
      mode: SlackChannelMode;
      dmPolicy: DmPolicy;
      allowedUsers: string[];
      hasBotToken: boolean;
      hasAppToken: boolean;
    };

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

export interface ChannelTargetSnapshot {
  channelId: SupportedChannelId;
  targetId: string;
  targetType: "channel";
  chatId: string;
  label: string;
  discoveredAt: string;
  lastSeenAt: string;
  lastMessageId?: string;
}

export interface ChannelConfigPatch {
  token?: string;
  botToken?: string;
  appToken?: string;
  mode?: SlackChannelMode;
  dmPolicy?: DmPolicy;
  allowedUsers?: string[];
}

function assertSupportedChannelId(
  channelId: string,
): asserts channelId is SupportedChannelId {
  if (!isSupportedChannelId(channelId)) {
    throw new Error(`Unsupported channel: ${channelId}`);
  }
}

function toConfigSnapshot(config: ChannelConfig): ChannelConfigSnapshot {
  if (config.channel === "telegram") {
    return {
      channelId: "telegram",
      enabled: config.enabled,
      dmPolicy: config.dmPolicy,
      allowedUsers: [...config.allowedUsers],
      hasToken: config.token.trim().length > 0,
    };
  }

  return {
    channelId: "slack",
    enabled: config.enabled,
    mode: config.mode,
    dmPolicy: config.dmPolicy,
    allowedUsers: [...config.allowedUsers],
    hasBotToken: config.botToken.trim().length > 0,
    hasAppToken: config.appToken.trim().length > 0,
  };
}

function toPendingPairingSnapshot(
  pending: Pick<
    PendingPairing,
    "code" | "senderId" | "senderName" | "chatId" | "createdAt" | "expiresAt"
  >,
): PendingPairingSnapshot {
  return {
    code: pending.code,
    senderId: pending.senderId,
    senderName: pending.senderName,
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

function toTargetSnapshot(
  channelId: SupportedChannelId,
  target: ChannelBindableTarget,
): ChannelTargetSnapshot {
  return {
    channelId,
    targetId: target.targetId,
    targetType: target.targetType,
    chatId: target.chatId,
    label: target.label,
    discoveredAt: target.discoveredAt,
    lastSeenAt: target.lastSeenAt,
    lastMessageId: target.lastMessageId,
  };
}

function isConfigReadyToStart(config: ChannelConfig): boolean {
  if (config.channel === "telegram") {
    return config.token.trim().length > 0;
  }
  return config.botToken.trim().length > 0 && config.appToken.trim().length > 0;
}

function getMissingCredentialError(config: ChannelConfig): string {
  if (config.channel === "telegram") {
    return 'Channel "telegram" is missing a token. Configure it first.';
  }
  return 'Channel "slack" is missing a bot token or app token. Configure it first.';
}

function mergeChannelConfig(
  channelId: SupportedChannelId,
  existing: ChannelConfig | null,
  patch: ChannelConfigPatch,
): ChannelConfig {
  if (channelId === "telegram") {
    const telegramExisting = existing?.channel === "telegram" ? existing : null;
    const merged: TelegramChannelConfig = {
      channel: "telegram",
      enabled: telegramExisting?.enabled ?? false,
      token: patch.token ?? telegramExisting?.token ?? "",
      dmPolicy: patch.dmPolicy ?? telegramExisting?.dmPolicy ?? "pairing",
      allowedUsers: patch.allowedUsers ?? telegramExisting?.allowedUsers ?? [],
    };
    return merged;
  }

  const slackExisting = existing?.channel === "slack" ? existing : null;
  const merged: SlackChannelConfig = {
    channel: "slack",
    enabled: slackExisting?.enabled ?? false,
    mode: patch.mode ?? slackExisting?.mode ?? "socket",
    botToken: patch.botToken ?? slackExisting?.botToken ?? "",
    appToken: patch.appToken ?? slackExisting?.appToken ?? "",
    dmPolicy: patch.dmPolicy ?? slackExisting?.dmPolicy ?? "pairing",
    allowedUsers: patch.allowedUsers ?? slackExisting?.allowedUsers ?? [],
  };
  return merged;
}

export function listChannelSummaries(): ChannelSummary[] {
  const registry = getChannelRegistry();
  return getSupportedChannelIds().map((channelId) => {
    const config = readChannelConfig(channelId);
    if (!config) {
      return {
        channelId,
        displayName: getChannelDisplayName(channelId),
        configured: false,
        enabled: false,
        running: false,
        dmPolicy: null,
        pendingPairingsCount: 0,
        approvedUsersCount: 0,
        routesCount: 0,
      };
    }

    loadRoutes(channelId);
    loadPairingStore(channelId);

    return {
      channelId,
      displayName: getChannelDisplayName(channelId),
      configured: true,
      enabled: config.enabled,
      running: registry?.getAdapter(channelId)?.isRunning() ?? false,
      dmPolicy: config.dmPolicy,
      pendingPairingsCount: getPendingPairings(channelId).length,
      approvedUsersCount: getApprovedUsers(channelId).length,
      routesCount: getRoutesForChannel(channelId).length,
    };
  });
}

export function getChannelConfigSnapshot(
  channelId: string,
): ChannelConfigSnapshot | null {
  assertSupportedChannelId(channelId);
  const config = readChannelConfig(channelId);
  if (!config) {
    return null;
  }
  return toConfigSnapshot(config);
}

export async function setChannelConfigLive(
  channelId: string,
  patch: ChannelConfigPatch,
): Promise<ChannelConfigSnapshot> {
  assertSupportedChannelId(channelId);

  const merged = mergeChannelConfig(
    channelId,
    readChannelConfig(channelId),
    patch,
  );
  writeChannelConfig(channelId, merged);

  if (merged.enabled) {
    await ensureChannelRegistry().startChannel(channelId);
  }

  return toConfigSnapshot(merged);
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
  if (!isConfigReadyToStart(existing)) {
    throw new Error(getMissingCredentialError(existing));
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

export function listChannelTargetSnapshots(
  channelId: string,
): ChannelTargetSnapshot[] {
  assertSupportedChannelId(channelId);
  loadTargetStore(channelId);
  return listChannelTargets(channelId).map((target) =>
    toTargetSnapshot(channelId, target),
  );
}

export function bindChannelTarget(
  channelId: string,
  targetId: string,
  agentId: string,
  conversationId: string,
): { chatId: string; route: ChannelRouteSnapshot } {
  assertSupportedChannelId(channelId);
  loadRoutes(channelId);
  loadTargetStore(channelId);

  const target = getChannelTarget(channelId, targetId);
  if (!target) {
    throw new Error(`Unknown channel target: ${targetId}`);
  }

  const route: ChannelRoute = {
    chatId: target.chatId,
    agentId,
    conversationId,
    enabled: true,
    createdAt: new Date().toISOString(),
  };

  try {
    addRoute(channelId, route);
    removeChannelTarget(channelId, targetId);
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "Failed to bind channel target",
    );
  }

  return {
    chatId: route.chatId,
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
