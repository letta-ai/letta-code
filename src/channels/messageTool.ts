import { getChannelDisplayName, loadChannelPlugin } from "./pluginRegistry";
import type {
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
} from "./pluginTypes";
import { getActiveChannelIds } from "./registry";
import type { SupportedChannelId } from "./types";

type ResolvedMessageChannelToolDiscovery = {
  activeChannels: SupportedChannelId[];
  actions: string[];
  schemaContributions: ChannelMessageToolSchemaContribution[];
};

type CachedDynamicMessageChannelTool = {
  description: string;
  schema: Record<string, unknown>;
};

const loggedDiscoveryErrors = new Set<string>();
let cachedDynamicMessageChannelTool: CachedDynamicMessageChannelTool | null =
  null;

/**
 * Build the public schema for the shared MessageChannel tool by merging
 * plugin-owned action discovery from each active channel.
 *
 * The top-level tool surface stays singular; individual channel plugins own
 * their actions and schema fragments underneath it.
 */
function asSchemaContributionArray(
  schema:
    | ChannelMessageToolSchemaContribution
    | ChannelMessageToolSchemaContribution[]
    | null
    | undefined,
): ChannelMessageToolSchemaContribution[] {
  if (!schema) {
    return [];
  }
  return Array.isArray(schema) ? schema : [schema];
}

function mergeSchemaContributions(
  schema: Record<string, unknown>,
  contributions: ChannelMessageToolSchemaContribution[],
): Record<string, unknown> {
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties) {
    return schema;
  }

  for (const contribution of contributions) {
    Object.assign(properties, structuredClone(contribution.properties));
  }

  return schema;
}

function collectDiscoveryActions(
  discovery: ChannelMessageToolDiscovery | null | undefined,
): string[] {
  return discovery?.actions ? Array.from(discovery.actions) : [];
}

function logDiscoveryError(
  channelId: SupportedChannelId,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const key = `${channelId}:${message}`;
  if (loggedDiscoveryErrors.has(key)) {
    return;
  }
  loggedDiscoveryErrors.add(key);
  console.error(
    `[Channels] ${channelId} MessageChannel discovery failed: ${message}`,
  );
}

function buildDynamicMessageChannelSchemaFromDiscovery(
  baseSchema: Record<string, unknown>,
  discovery: ResolvedMessageChannelToolDiscovery,
): Record<string, unknown> {
  const schema = structuredClone(baseSchema);
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) {
    return schema;
  }

  if (properties.channel && discovery.activeChannels.length > 0) {
    properties.channel.enum = [...discovery.activeChannels];
  }

  if (properties.action) {
    properties.action.enum = [...discovery.actions];
  }

  return mergeSchemaContributions(schema, discovery.schemaContributions);
}

function buildDynamicMessageChannelDescriptionFromDiscovery(
  baseDescription: string,
  discovery: ResolvedMessageChannelToolDiscovery,
): string {
  const description = baseDescription.trim();
  if (discovery.activeChannels.length === 0) {
    return `${description}\n\nNo external channel adapters are currently running.`;
  }

  const channelList = discovery.activeChannels
    .map((channelId) => getChannelDisplayName(channelId))
    .join(", ");
  const actionList = discovery.actions.join(", ");

  return `${description}\n\nCurrently active channels: ${channelList}. Available actions across the active channels: ${actionList}. The JSON schema reflects the currently active channel plugins.`;
}

export async function resolveMessageChannelToolDiscovery(): Promise<ResolvedMessageChannelToolDiscovery> {
  const activeChannels = getActiveChannelIds() as SupportedChannelId[];
  const actions = new Set<string>(["send"]);
  const schemaContributions: ChannelMessageToolSchemaContribution[] = [];

  for (const channelId of activeChannels) {
    try {
      const plugin = await loadChannelPlugin(channelId);
      const discovery = plugin.messageActions?.describeMessageTool({
        accountId: null,
      });

      for (const action of collectDiscoveryActions(discovery)) {
        actions.add(action);
      }
      schemaContributions.push(...asSchemaContributionArray(discovery?.schema));
    } catch (error) {
      logDiscoveryError(channelId, error);
    }
  }

  return {
    activeChannels,
    actions: Array.from(actions),
    schemaContributions,
  };
}

export async function buildDynamicMessageChannelSchema(
  baseSchema: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const discovery = await resolveMessageChannelToolDiscovery();
  return buildDynamicMessageChannelSchemaFromDiscovery(baseSchema, discovery);
}

export async function buildDynamicMessageChannelToolDefinition(
  baseDescription: string,
  baseSchema: Record<string, unknown>,
): Promise<CachedDynamicMessageChannelTool> {
  const discovery = await resolveMessageChannelToolDiscovery();
  const resolved = {
    description: buildDynamicMessageChannelDescriptionFromDiscovery(
      baseDescription,
      discovery,
    ),
    schema: buildDynamicMessageChannelSchemaFromDiscovery(
      baseSchema,
      discovery,
    ),
  };
  cachedDynamicMessageChannelTool = {
    description: resolved.description,
    schema: structuredClone(resolved.schema),
  };
  return resolved;
}

export function getCachedDynamicMessageChannelToolDefinition(): CachedDynamicMessageChannelTool | null {
  if (!cachedDynamicMessageChannelTool) {
    return null;
  }
  return {
    description: cachedDynamicMessageChannelTool.description,
    schema: structuredClone(cachedDynamicMessageChannelTool.schema),
  };
}

export function clearDynamicMessageChannelToolCache(): void {
  cachedDynamicMessageChannelTool = null;
  loggedDiscoveryErrors.clear();
}
