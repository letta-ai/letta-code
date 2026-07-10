import { getChannelDisplayName, loadChannelPlugin } from "./plugin-registry";
import type {
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
} from "./plugin-types";
import { getActiveChannelIds } from "./registry";
import type { SupportedChannelId } from "./types";

export type MessageChannelToolScopeEntry = {
  channelId: SupportedChannelId;
  accountId?: string | null;
};

export type MessageChannelToolDiscoveryScope = {
  channels: MessageChannelToolScopeEntry[];
};

type ResolvedMessageChannelToolDiscovery = {
  activeChannels: SupportedChannelId[];
  accountIds: string[];
  actions: string[];
  schemaContributions: ChannelMessageToolSchemaContribution[];
};

type CachedDynamicMessageChannelTool = {
  description: string;
  schema: Record<string, unknown>;
};

const TELEGRAM_RICH_RULE_RE =
  /\n- Telegram supports `action="send-rich"`[^\n]*\n?/;
const TELEGRAM_RICH_SECTION_RE = /\n\nTelegram rich messages:\n[\s\S]*$/;

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

  if (properties.accountId && discovery.accountIds.length > 0) {
    properties.accountId.enum = [...discovery.accountIds];
  }

  if (properties.action) {
    properties.action.enum = [...discovery.actions];
  }

  return mergeSchemaContributions(schema, discovery.schemaContributions);
}

function buildDynamicMessageChannelDescriptionFromDiscovery(
  baseDescription: string,
  discovery: ResolvedMessageChannelToolDiscovery,
  scope?: MessageChannelToolDiscoveryScope | null,
): string {
  const description = pruneInactiveChannelGuidance(
    baseDescription,
    discovery.activeChannels,
  ).trim();
  if (discovery.activeChannels.length === 0) {
    return `${description}\n\nNo external channel adapters are currently running.`;
  }

  const channelList = discovery.activeChannels
    .map((channelId) => getChannelDisplayName(channelId))
    .join(", ");
  const actionList = discovery.actions.join(", ");

  const scopedChannels = scope?.channels ?? [];
  const scopedReplyContract =
    scopedChannels.length > 0
      ? '\n\nThis tool is currently scoped to a routed external channel turn. Plain assistant text is not delivered to that external user. If a user-visible reply is appropriate, your final action for the turn must be one MessageChannel call with action="send", channel from the notification, chat_id from the notification, and message containing the reply. If no user-visible response is appropriate, do not call MessageChannel and do not send an empty acknowledgement. For lightweight acknowledgement, prefer action="react" when supported. If the useful response belongs later, schedule the follow-up instead of sending a placeholder.'
      : "";
  const slackWorkAcknowledgement = discovery.activeChannels.includes("slack")
    ? '\n\nFor Slack requests that require nontrivial work or several tool calls, send one short MessageChannel call with action="send" before starting other tools. This gives the Slack user verbal acknowledgement and a View in web link. Do not do this for no-ops, reaction-only responses, or simple no-tool answers.'
    : "";

  return `${description}${scopedReplyContract}${slackWorkAcknowledgement}\n\nCurrently active channels: ${channelList}. Available actions across the active channels: ${actionList}. The JSON schema reflects the currently active channel plugins.`;
}

function pruneInactiveChannelGuidance(
  baseDescription: string,
  activeChannels: SupportedChannelId[],
): string {
  let description = baseDescription.trim();
  if (!activeChannels.includes("telegram")) {
    description = description
      .replace(TELEGRAM_RICH_RULE_RE, "\n")
      .replace(TELEGRAM_RICH_SECTION_RE, "");
  }
  return description.trim();
}

export async function resolveMessageChannelToolDiscovery(
  scope?: MessageChannelToolDiscoveryScope | null,
): Promise<ResolvedMessageChannelToolDiscovery> {
  const scopedChannels = scope?.channels ?? [];
  const discoveryTargets =
    scopedChannels.length > 0
      ? scopedChannels
      : (getActiveChannelIds() as SupportedChannelId[]).map((channelId) => ({
          channelId,
          accountId: null,
        }));
  const activeChannels = Array.from(
    new Set(discoveryTargets.map(({ channelId }) => channelId)),
  );
  const accountIds = Array.from(
    new Set(
      discoveryTargets
        .map(({ accountId }) => accountId?.trim())
        .filter((accountId): accountId is string => Boolean(accountId)),
    ),
  );
  const actions = new Set<string>(["send"]);
  const schemaContributions: ChannelMessageToolSchemaContribution[] = [];

  for (const { channelId, accountId } of discoveryTargets) {
    try {
      const plugin = await loadChannelPlugin(channelId);
      const discovery = plugin.messageActions?.describeMessageTool({
        accountId: accountId ?? null,
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
    accountIds,
    actions: Array.from(actions),
    schemaContributions,
  };
}

export async function buildDynamicMessageChannelSchema(
  baseSchema: Record<string, unknown>,
  scope?: MessageChannelToolDiscoveryScope | null,
): Promise<Record<string, unknown>> {
  const discovery = await resolveMessageChannelToolDiscovery(scope);
  return buildDynamicMessageChannelSchemaFromDiscovery(baseSchema, discovery);
}

export async function buildDynamicMessageChannelToolDefinition(
  baseDescription: string,
  baseSchema: Record<string, unknown>,
  scope?: MessageChannelToolDiscoveryScope | null,
): Promise<CachedDynamicMessageChannelTool> {
  const discovery = await resolveMessageChannelToolDiscovery(scope);
  const resolved = {
    description: buildDynamicMessageChannelDescriptionFromDiscovery(
      baseDescription,
      discovery,
      scope,
    ),
    schema: buildDynamicMessageChannelSchemaFromDiscovery(
      baseSchema,
      discovery,
    ),
  };
  if (!scope || scope.channels.length === 0) {
    cachedDynamicMessageChannelTool = {
      description: resolved.description,
      schema: structuredClone(resolved.schema),
    };
  }
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
