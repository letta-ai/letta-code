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
let cachedDynamicMessageChannelTool: ResolvedMessageChannelToolDefinition | null =
  null;

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

async function resolveLocalToolChannels(
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
    await resolveLocalToolChannels(scope),
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
  const resolved = buildMessageChannelToolFromDiscovery({
    baseDescription,
    baseSchema,
    discovery: await resolveMessageChannelToolDiscovery(scope),
    scoped: Boolean(scope?.channels.length),
  });
  if (!scope || scope.channels.length === 0) {
    cachedDynamicMessageChannelTool = {
      description: resolved.description,
      schema: structuredClone(resolved.schema),
    };
  }
  return resolved;
}

export function getCachedDynamicMessageChannelToolDefinition(): ResolvedMessageChannelToolDefinition | null {
  if (!cachedDynamicMessageChannelTool) return null;
  return {
    description: cachedDynamicMessageChannelTool.description,
    schema: structuredClone(cachedDynamicMessageChannelTool.schema),
  };
}

export function clearDynamicMessageChannelToolCache(): void {
  cachedDynamicMessageChannelTool = null;
  loggedDiscoveryErrors.clear();
}
