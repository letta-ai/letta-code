import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getChannelAccount } from "./accounts";
import { getChannelsRoot } from "./config";
import { isSupportedChannelId, loadChannelPlugin } from "./pluginRegistry";
import type { ChannelMessageActionRequest } from "./pluginTypes";
import { getChannelRegistry } from "./registry";
import type { ChannelRoute, SupportedChannelId } from "./types";

export interface OperatorDestination {
  id: string;
  agentId: string;
  conversationId?: string | null;
  label?: string;
  enabled: boolean;
  channel: SupportedChannelId;
  accountId: string;
  chatId: string;
  threadId?: string | null;
  notifyOnErrors: boolean;
  notifyOnRetries: boolean;
  useAsMessageChannelDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OperatorDestinationInput {
  id?: string;
  agentId: string;
  conversationId?: string | null;
  label?: string;
  enabled?: boolean;
  channel: SupportedChannelId;
  accountId: string;
  chatId: string;
  threadId?: string | null;
  notifyOnErrors?: boolean;
  notifyOnRetries?: boolean;
  useAsMessageChannelDefault?: boolean;
}

interface OperatorDestinationStore {
  destinations: OperatorDestination[];
}

export interface OperatorDeliveryResult {
  delivered: boolean;
  reason?: string;
  messageId?: string;
}

const DEFAULT_STORE: OperatorDestinationStore = { destinations: [] };
let store: OperatorDestinationStore | null = null;
let loadStoreOverride: (() => OperatorDestination[] | null) | null = null;
let saveStoreOverride: ((destinations: OperatorDestination[]) => void) | null =
  null;

const recentNotificationKeys = new Map<string, number>();
const OPERATOR_NOTIFICATION_DEDUPE_MS = 5 * 60 * 1000;

export function getOperatorDestinationsPath(): string {
  return join(getChannelsRoot(), "operators.json");
}

function cloneDestination(
  destination: OperatorDestination,
): OperatorDestination {
  return { ...destination };
}

function normalizeOptionalString(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function assertValidDestinationInput(input: OperatorDestinationInput): void {
  if (!input.agentId.trim()) {
    throw new Error("Operator destination requires agentId.");
  }
  if (!isSupportedChannelId(input.channel)) {
    throw new Error(`Unsupported operator channel: ${input.channel}`);
  }
  if (!input.accountId.trim()) {
    throw new Error("Operator destination requires accountId.");
  }
  if (!input.chatId.trim()) {
    throw new Error("Operator destination requires chatId.");
  }
}

function normalizeLoadedDestination(
  value: Partial<OperatorDestination>,
): OperatorDestination | null {
  if (
    typeof value.id !== "string" ||
    typeof value.agentId !== "string" ||
    typeof value.channel !== "string" ||
    typeof value.accountId !== "string" ||
    typeof value.chatId !== "string" ||
    !isSupportedChannelId(value.channel)
  ) {
    return null;
  }

  const now = new Date().toISOString();
  return {
    id: value.id,
    agentId: value.agentId,
    conversationId: normalizeOptionalString(value.conversationId),
    label: normalizeOptionalString(value.label) ?? undefined,
    enabled: value.enabled !== false,
    channel: value.channel,
    accountId: value.accountId,
    chatId: value.chatId,
    threadId: normalizeOptionalString(value.threadId),
    notifyOnErrors: value.notifyOnErrors !== false,
    notifyOnRetries: value.notifyOnRetries === true,
    useAsMessageChannelDefault: value.useAsMessageChannelDefault !== false,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
  };
}

export function loadOperatorDestinations(): void {
  if (loadStoreOverride) {
    store = {
      destinations: (loadStoreOverride() ?? []).map(cloneDestination),
    };
    return;
  }

  const path = getOperatorDestinationsPath();
  if (!existsSync(path)) {
    store = { ...DEFAULT_STORE, destinations: [] };
    return;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<{
      destinations: Array<Partial<OperatorDestination>>;
    }>;
    store = {
      destinations: (parsed.destinations ?? [])
        .map(normalizeLoadedDestination)
        .filter(
          (destination): destination is OperatorDestination =>
            destination !== null,
        ),
    };
  } catch {
    store = { ...DEFAULT_STORE, destinations: [] };
  }
}

function getStore(): OperatorDestinationStore {
  if (!store) {
    loadOperatorDestinations();
  }
  if (!store) {
    store = { ...DEFAULT_STORE, destinations: [] };
  }
  return store;
}

function saveOperatorDestinations(): void {
  const destinations = getStore().destinations.map(cloneDestination);
  if (saveStoreOverride) {
    saveStoreOverride(destinations);
    return;
  }

  mkdirSync(getChannelsRoot(), { recursive: true });
  writeFileSync(
    getOperatorDestinationsPath(),
    `${JSON.stringify({ destinations }, null, 2)}\n`,
    "utf-8",
  );
}

export function listOperatorDestinations(
  agentId?: string,
): OperatorDestination[] {
  const normalizedAgentId = agentId?.trim();
  return getStore()
    .destinations.filter(
      (destination) =>
        !normalizedAgentId || destination.agentId === normalizedAgentId,
    )
    .map(cloneDestination);
}

export function resolveOperatorDestination(params: {
  agentId: string;
  conversationId?: string | null;
  requireMessageChannelDefault?: boolean;
  requireErrorNotifications?: boolean;
  requireRetryNotifications?: boolean;
}): OperatorDestination | null {
  const agentId = params.agentId.trim();
  const conversationId = normalizeOptionalString(params.conversationId);
  if (!agentId) return null;

  const candidates = getStore().destinations.filter((destination) => {
    if (destination.agentId !== agentId || !destination.enabled) return false;
    if (
      params.requireMessageChannelDefault &&
      !destination.useAsMessageChannelDefault
    ) {
      return false;
    }
    if (params.requireErrorNotifications && !destination.notifyOnErrors) {
      return false;
    }
    if (params.requireRetryNotifications && !destination.notifyOnRetries) {
      return false;
    }
    return true;
  });

  const selected =
    candidates.find(
      (destination) =>
        normalizeOptionalString(destination.conversationId) === conversationId,
    ) ??
    candidates.find(
      (destination) => !normalizeOptionalString(destination.conversationId),
    ) ??
    null;

  return selected ? cloneDestination(selected) : null;
}

export function upsertOperatorDestination(
  input: OperatorDestinationInput,
): OperatorDestination {
  assertValidDestinationInput(input);
  const now = new Date().toISOString();
  const normalizedId = input.id?.trim() || randomUUID();
  const next: OperatorDestination = {
    id: normalizedId,
    agentId: input.agentId.trim(),
    conversationId: normalizeOptionalString(input.conversationId),
    label: normalizeOptionalString(input.label) ?? undefined,
    enabled: input.enabled !== false,
    channel: input.channel,
    accountId: input.accountId.trim(),
    chatId: input.chatId.trim(),
    threadId: normalizeOptionalString(input.threadId),
    notifyOnErrors: input.notifyOnErrors !== false,
    notifyOnRetries: input.notifyOnRetries === true,
    useAsMessageChannelDefault: input.useAsMessageChannelDefault !== false,
    createdAt: now,
    updatedAt: now,
  };

  const current = getStore();
  const normalizedConversationId = normalizeOptionalString(
    input.conversationId,
  );
  const existingIndex = input.id?.trim()
    ? current.destinations.findIndex(
        (destination) => destination.id === normalizedId,
      )
    : current.destinations.findIndex(
        (destination) =>
          destination.agentId === input.agentId.trim() &&
          normalizeOptionalString(destination.conversationId) ===
            normalizedConversationId,
      );
  if (existingIndex >= 0) {
    const existing = current.destinations[existingIndex];
    next.id = existing?.id ?? next.id;
    next.createdAt = existing?.createdAt ?? now;
    current.destinations[existingIndex] = next;
  } else {
    current.destinations.push(next);
  }
  saveOperatorDestinations();
  return cloneDestination(next);
}

export function removeOperatorDestination(id: string): boolean {
  const normalizedId = id.trim();
  if (!normalizedId) return false;
  const current = getStore();
  const before = current.destinations.length;
  current.destinations = current.destinations.filter(
    (destination) => destination.id !== normalizedId,
  );
  if (current.destinations.length === before) return false;
  saveOperatorDestinations();
  return true;
}

function buildSyntheticOperatorRoute(params: {
  destination: OperatorDestination;
  conversationId: string;
}): ChannelRoute {
  const now = new Date().toISOString();
  return {
    accountId: params.destination.accountId,
    chatId: params.destination.chatId,
    threadId: params.destination.threadId ?? null,
    agentId: params.destination.agentId,
    conversationId: params.conversationId,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

export async function sendOperatorMessage(params: {
  agentId: string;
  conversationId?: string | null;
  message: string;
  retryNotice?: boolean;
  dedupeKey?: string;
}): Promise<OperatorDeliveryResult> {
  try {
    const destination = resolveOperatorDestination({
      agentId: params.agentId,
      conversationId: params.conversationId,
      requireErrorNotifications: !params.retryNotice,
      requireRetryNotifications: params.retryNotice === true,
    });
    if (!destination) {
      return { delivered: false, reason: "No operator destination configured" };
    }

    if (params.dedupeKey) {
      const now = Date.now();
      for (const [key, timestamp] of recentNotificationKeys) {
        if (now - timestamp > OPERATOR_NOTIFICATION_DEDUPE_MS) {
          recentNotificationKeys.delete(key);
        }
      }
      const previous = recentNotificationKeys.get(params.dedupeKey);
      if (previous && now - previous < OPERATOR_NOTIFICATION_DEDUPE_MS) {
        return { delivered: false, reason: "Duplicate operator notification" };
      }
    }

    if (!getChannelAccount(destination.channel, destination.accountId)) {
      return { delivered: false, reason: "Operator channel account not found" };
    }

    const registry = getChannelRegistry();
    const adapter = registry?.getAdapter(
      destination.channel,
      destination.accountId,
    );
    if (!adapter?.isRunning()) {
      return { delivered: false, reason: "Operator channel is not running" };
    }

    const plugin = await loadChannelPlugin(destination.channel);
    if (!plugin.messageActions) {
      return {
        delivered: false,
        reason: "Operator channel does not expose MessageChannel actions",
      };
    }

    const request: ChannelMessageActionRequest = {
      action: "send",
      channel: destination.channel,
      chatId: destination.chatId,
      threadId: destination.threadId ?? null,
      message: params.message,
    };
    const result = await plugin.messageActions.handleAction({
      request,
      route: buildSyntheticOperatorRoute({
        destination,
        conversationId: params.conversationId ?? "default",
      }),
      adapter,
      formatText: (text) => ({ text }),
    });
    const messageIdMatch = result.match(/message_id:\s*([^)\s]+)/i);
    if (params.dedupeKey) {
      recentNotificationKeys.set(params.dedupeKey, Date.now());
    }
    return {
      delivered: true,
      ...(messageIdMatch?.[1] ? { messageId: messageIdMatch[1] } : {}),
    };
  } catch (error) {
    return {
      delivered: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function __testOverrideOperatorDestinationStore(
  load: (() => OperatorDestination[] | null) | null,
  save?: ((destinations: OperatorDestination[]) => void) | null,
): void {
  loadStoreOverride = load;
  saveStoreOverride = save ?? null;
  store = null;
  recentNotificationKeys.clear();
}

export function __testClearOperatorDestinationStore(): void {
  store = { destinations: [] };
  recentNotificationKeys.clear();
}
