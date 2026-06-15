import type { MessageChannelToolDiscoveryScope } from "@/channels/message-tool";
import { getChannelRegistry } from "@/channels/registry";
import { getRoutesForChannel, loadRoutes } from "@/channels/routing";
import type { ChannelChatType, ChannelTurnSource } from "@/channels/types";
import { isRecord } from "@/utils/type-guards";

export interface CronChannelTarget {
  channel: string;
  account_id?: string | null;
  chat_id: string;
  chat_type?: ChannelChatType;
  thread_id?: string | null;
  message_id?: string | null;
}

export interface ResolvedCronChannelContext {
  channelToolScope: MessageChannelToolDiscoveryScope;
  channelTurnSources: ChannelTurnSource[];
  availableTargets: CronChannelTarget[];
}

interface CronChannelTaskScope {
  agent_id: string;
  channel_targets: CronChannelTarget[];
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return asNonEmptyString(value) ?? undefined;
}

function normalizeChatType(value: unknown): ChannelChatType | undefined {
  return value === "direct" || value === "channel" ? value : undefined;
}

function targetKey(target: CronChannelTarget): string {
  return [
    target.channel,
    target.account_id ?? "",
    target.chat_id,
    target.chat_type ?? "",
    target.thread_id ?? "",
    target.message_id ?? "",
  ].join("\t");
}

export function normalizeCronChannelTargets(
  value: unknown,
): CronChannelTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const targets: CronChannelTarget[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const channel = asNonEmptyString(entry.channel);
    const chatId = asNonEmptyString(entry.chat_id ?? entry.chatId);
    if (!channel || !chatId) {
      continue;
    }

    const target: CronChannelTarget = {
      channel,
      chat_id: chatId,
      ...(normalizeNullableString(entry.account_id ?? entry.accountId) !==
      undefined
        ? {
            account_id: normalizeNullableString(
              entry.account_id ?? entry.accountId,
            ),
          }
        : {}),
      ...(normalizeChatType(entry.chat_type ?? entry.chatType)
        ? { chat_type: normalizeChatType(entry.chat_type ?? entry.chatType) }
        : {}),
      ...(normalizeNullableString(entry.thread_id ?? entry.threadId) !==
      undefined
        ? {
            thread_id: normalizeNullableString(
              entry.thread_id ?? entry.threadId,
            ),
          }
        : {}),
      ...(normalizeNullableString(entry.message_id ?? entry.messageId) !==
      undefined
        ? {
            message_id: normalizeNullableString(
              entry.message_id ?? entry.messageId,
            ),
          }
        : {}),
    };

    const key = targetKey(target);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    targets.push(target);
  }

  return targets;
}

function channelTurnSourceToCronTarget(
  source: Record<string, unknown>,
): CronChannelTarget | null {
  const channel = asNonEmptyString(source.channel);
  const chatId = asNonEmptyString(source.chatId);
  if (!channel || !chatId) {
    return null;
  }

  return {
    channel,
    chat_id: chatId,
    ...(asNonEmptyString(source.accountId)
      ? { account_id: asNonEmptyString(source.accountId) }
      : {}),
    ...(normalizeChatType(source.chatType)
      ? { chat_type: normalizeChatType(source.chatType) }
      : {}),
    ...(normalizeNullableString(source.threadId) !== undefined
      ? { thread_id: normalizeNullableString(source.threadId) }
      : {}),
    ...(asNonEmptyString(source.messageId)
      ? { message_id: asNonEmptyString(source.messageId) }
      : {}),
  };
}

export function extractCronChannelTargetsFromInheritedContext(params: {
  raw: string | undefined;
  agentId: string;
  conversationId: string;
}): CronChannelTarget[] {
  if (!params.raw) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(params.raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.channelTurnSources)) {
      return [];
    }

    const targets: CronChannelTarget[] = [];
    for (const entry of parsed.channelTurnSources) {
      if (
        !isRecord(entry) ||
        entry.agentId !== params.agentId ||
        entry.conversationId !== params.conversationId
      ) {
        continue;
      }
      const target = channelTurnSourceToCronTarget(entry);
      if (target) {
        targets.push(target);
      }
    }

    return normalizeCronChannelTargets(targets);
  } catch {
    return [];
  }
}

function findMatchingRoutes(params: {
  task: CronChannelTaskScope;
  target: CronChannelTarget;
  conversationId: string;
}): CronChannelTarget[] {
  loadRoutes(params.target.channel);
  const routes = getRoutesForChannel(params.target.channel).filter((route) => {
    if (
      route.agentId !== params.task.agent_id ||
      route.conversationId !== params.conversationId ||
      route.chatId !== params.target.chat_id ||
      !route.enabled
    ) {
      return false;
    }
    if (
      params.target.account_id &&
      (route.accountId ?? null) !== params.target.account_id
    ) {
      return false;
    }
    if (
      params.target.thread_id !== undefined &&
      (route.threadId ?? null) !== (params.target.thread_id ?? null)
    ) {
      return false;
    }
    return true;
  });

  return routes.map((route) => ({
    ...params.target,
    ...(route.accountId ? { account_id: route.accountId } : {}),
    ...(route.chatType ? { chat_type: route.chatType } : {}),
    ...(route.threadId !== undefined ? { thread_id: route.threadId } : {}),
  }));
}

export function resolveCronChannelContext(params: {
  task: CronChannelTaskScope;
  conversationId: string;
}): ResolvedCronChannelContext {
  const registry = getChannelRegistry();
  const availableTargets: CronChannelTarget[] = [];

  if (registry) {
    for (const target of params.task.channel_targets) {
      for (const matched of findMatchingRoutes({
        task: params.task,
        target,
        conversationId: params.conversationId,
      })) {
        const adapter = registry.getAdapter(
          matched.channel,
          matched.account_id ?? undefined,
        );
        if (!adapter?.isRunning()) {
          continue;
        }
        availableTargets.push(matched);
      }
    }
  }

  const normalizedTargets = normalizeCronChannelTargets(availableTargets);
  const scopeSeen = new Set<string>();
  const channelToolScope: MessageChannelToolDiscoveryScope = { channels: [] };
  const channelTurnSources: ChannelTurnSource[] = [];

  for (const target of normalizedTargets) {
    const scopeKey = `${target.channel}:${target.account_id ?? ""}`;
    if (!scopeSeen.has(scopeKey)) {
      scopeSeen.add(scopeKey);
      channelToolScope.channels.push({
        channelId: target.channel,
        accountId: target.account_id ?? null,
      });
    }

    channelTurnSources.push({
      channel: target.channel,
      ...(target.account_id ? { accountId: target.account_id } : {}),
      chatId: target.chat_id,
      ...(target.chat_type ? { chatType: target.chat_type } : {}),
      ...(target.message_id ? { messageId: target.message_id } : {}),
      ...(target.thread_id !== undefined ? { threadId: target.thread_id } : {}),
      agentId: params.task.agent_id,
      conversationId: params.conversationId,
    });
  }

  return {
    channelToolScope,
    channelTurnSources,
    availableTargets: normalizedTargets,
  };
}

export function formatCronChannelTargetForPrompt(
  target: CronChannelTarget,
): string {
  const args = [
    'action="send"',
    `channel="${target.channel}"`,
    `chat_id="${target.chat_id}"`,
  ];
  if (target.account_id) {
    args.push(`accountId="${target.account_id}"`);
  }
  if (target.thread_id) {
    args.push(`threadId="${target.thread_id}"`);
  }
  return `MessageChannel(${args.join(", ")}, message="...")`;
}
