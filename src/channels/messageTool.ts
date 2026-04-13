import { loadChannelPlugin } from "./pluginRegistry";
import type {
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
} from "./pluginTypes";
import { getActiveChannelIds } from "./registry";
import type { SupportedChannelId } from "./types";

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

export async function buildDynamicMessageChannelSchema(
  baseSchema: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const schema = structuredClone(baseSchema);
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) {
    return schema;
  }

  const activeChannels = getActiveChannelIds();
  if (properties.channel && activeChannels.length > 0) {
    properties.channel.enum = activeChannels;
  }

  const actionEnum = new Set<string>(["send"]);
  const contributions: ChannelMessageToolSchemaContribution[] = [];

  for (const channelId of activeChannels) {
    const plugin = await loadChannelPlugin(channelId as SupportedChannelId);
    const discovery = plugin.messageActions?.describeMessageTool({
      accountId: null,
    });

    for (const action of collectDiscoveryActions(discovery)) {
      actionEnum.add(action);
    }
    contributions.push(...asSchemaContributionArray(discovery?.schema));
  }

  if (properties.action) {
    properties.action.enum = Array.from(actionEnum);
  }

  return mergeSchemaContributions(schema, contributions);
}
