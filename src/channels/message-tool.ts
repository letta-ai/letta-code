import {
  buildMessageChannelSchemaFromDiscovery,
  buildMessageChannelToolFromDiscovery,
  type MessageChannelToolChannel,
  type MessageChannelToolDiscoveryResult,
  type ResolvedMessageChannelToolDefinition,
  resolveMessageChannelToolChannels,
} from "./message-channel-tool-definition";
import { getChannelDisplayName, loadChannelPlugin } from "./plugin-registry";
import { getActiveChannelIds } from "./registry";
import type { SupportedChannelId } from "./types";

export type MessageChannelToolScopeEntry = {
  channelId: SupportedChannelId;
  accountId?: string | null;
};

export type MessageChannelToolDiscoveryScope = {
  channels: MessageChannelToolScopeEntry[];
};

const loggedDiscoveryErrors = new Set<string>();

function logDiscoveryError(
  channelId: SupportedChannelId,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const key = `${channelId}:${message}`;
  if (loggedDiscoveryErrors.has(key)) return;
  loggedDiscoveryErrors.add(key);
  console.error(
    `[Channels] ${channelId} MessageChannel discovery failed: ${message}`,
  );
}

export async function resolveLocalMessageChannelToolChannels(
  scope?: MessageChannelToolDiscoveryScope | null,
): Promise<MessageChannelToolChannel[]> {
  const scopedChannels = scope?.channels ?? [];
  const targets =
    scopedChannels.length > 0
      ? scopedChannels
      : (getActiveChannelIds() as SupportedChannelId[]).map((channelId) => ({
          channelId,
          accountId: null,
        }));
  const channels: MessageChannelToolChannel[] = [];
  for (const { channelId, accountId } of targets) {
    const channel = {
      channelId,
      displayName: getChannelDisplayName(channelId),
      accountId,
    };
    try {
      const plugin = await loadChannelPlugin(channelId);
      channels.push({
        ...channel,
        messageActions: plugin.messageActions,
      });
    } catch (error) {
      logDiscoveryError(channelId, error);
      channels.push(channel);
    }
  }
  return channels;
}

export async function resolveMessageChannelToolDiscovery(
  scope?: MessageChannelToolDiscoveryScope | null,
): Promise<MessageChannelToolDiscoveryResult> {
  return resolveMessageChannelToolChannels(
    await resolveLocalMessageChannelToolChannels(scope),
  );
}

export async function buildDynamicMessageChannelSchema(
  baseSchema: Record<string, unknown>,
  scope?: MessageChannelToolDiscoveryScope | null,
): Promise<Record<string, unknown>> {
  return buildMessageChannelSchemaFromDiscovery(
    baseSchema,
    await resolveMessageChannelToolDiscovery(scope),
  );
}

export async function buildDynamicMessageChannelToolDefinition(
  baseDescription: string,
  baseSchema: Record<string, unknown>,
  scope?: MessageChannelToolDiscoveryScope | null,
): Promise<ResolvedMessageChannelToolDefinition> {
  return buildMessageChannelToolFromDiscovery({
    baseDescription,
    baseSchema,
    discovery: await resolveMessageChannelToolDiscovery(scope),
    scoped: Boolean(scope?.channels.length),
  });
}

export function clearMessageChannelDiscoveryErrors(): void {
  loggedDiscoveryErrors.clear();
}
