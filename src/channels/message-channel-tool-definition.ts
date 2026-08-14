import MessageChannelDescription from "@/tools/descriptions/MessageChannel.md";
import MessageChannelSchema from "@/tools/schemas/MessageChannel.json";
import type { ExternalToolDefinitionPayload } from "@/types/app-server-protocol";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
} from "./plugin-types";
import type { SupportedChannelId } from "./types";

export interface MessageChannelToolChannel {
  channelId: SupportedChannelId;
  displayName: string;
  accountId?: string | null;
  messageActions?: Pick<
    ChannelMessageActionAdapter,
    "describeMessageTool"
  > | null;
}

export interface MessageChannelToolDiscoveryResult {
  activeChannels: SupportedChannelId[];
  displayNames: string[];
  accountIds: string[];
  actions: string[];
  schemaContributions: ChannelMessageToolSchemaContribution[];
}

export interface BuildMessageChannelToolOptions {
  channels: readonly MessageChannelToolChannel[];
  /** Whether this tool is attached to one routed external-channel scope. */
  scoped: boolean;
  /** Advertise target-based proactive sends when the host can resolve them. */
  allowProactiveTargets?: boolean;
}

export interface ResolvedMessageChannelToolDefinition {
  description: string;
  schema: Record<string, unknown>;
}

const TELEGRAM_RICH_RULE_RE =
  /\n- Telegram supports `action="send-rich"`[^\n]*\n?/;
const TELEGRAM_RICH_SECTION_RE = /\n\nTelegram rich messages:\n[\s\S]*$/;
const MESSAGE_CHANNEL_PARAMETER_LINE = (name: string): RegExp =>
  new RegExp(`\\n- \`${name}\`:[^\\n]*`, "g");

function asSchemaContributionArray(
  schema:
    | ChannelMessageToolSchemaContribution
    | ChannelMessageToolSchemaContribution[]
    | null
    | undefined,
): ChannelMessageToolSchemaContribution[] {
  if (!schema) return [];
  return Array.isArray(schema) ? schema : [schema];
}

function collectDiscoveryActions(
  discovery: ChannelMessageToolDiscovery | null | undefined,
): string[] {
  return discovery?.actions ? Array.from(discovery.actions) : [];
}

export function resolveMessageChannelToolChannels(
  channels: readonly MessageChannelToolChannel[],
): MessageChannelToolDiscoveryResult {
  const uniqueChannels = new Map<string, MessageChannelToolChannel>();
  const accountIds = new Set<string>();
  const actions = new Set<string>(["send"]);
  const schemaContributions: ChannelMessageToolSchemaContribution[] = [];

  for (const channel of channels) {
    if (!uniqueChannels.has(channel.channelId)) {
      uniqueChannels.set(channel.channelId, channel);
    }
    const accountId = channel.accountId?.trim();
    if (accountId) accountIds.add(accountId);
    const discovery = channel.messageActions?.describeMessageTool({
      accountId: accountId ?? null,
    });
    for (const action of collectDiscoveryActions(discovery))
      actions.add(action);
    schemaContributions.push(...asSchemaContributionArray(discovery?.schema));
  }

  return {
    activeChannels: [...uniqueChannels.keys()],
    displayNames: [...uniqueChannels.values()].map(
      (channel) => channel.displayName,
    ),
    accountIds: [...accountIds],
    actions: [...actions],
    schemaContributions,
  };
}

function mergeSchemaContributions(
  schema: Record<string, unknown>,
  contributions: ChannelMessageToolSchemaContribution[],
): Record<string, unknown> {
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties) return schema;
  for (const contribution of contributions) {
    Object.assign(properties, structuredClone(contribution.properties));
  }
  return schema;
}

export function buildMessageChannelSchemaFromDiscovery(
  baseSchema: Record<string, unknown>,
  discovery: MessageChannelToolDiscoveryResult,
  allowProactiveTargets = true,
): Record<string, unknown> {
  const schema = structuredClone(baseSchema);
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) return schema;

  if (properties.channel && discovery.activeChannels.length > 0) {
    properties.channel.enum = [...discovery.activeChannels];
    properties.channel.description = `Channel to send the message to. Available channels: ${discovery.activeChannels.join(", ")}.`;
  }
  if (properties.accountId && discovery.accountIds.length > 0) {
    properties.accountId.enum = [...discovery.accountIds];
  }
  if (properties.action) {
    properties.action.enum = [...discovery.actions];
    properties.action.description = `Action to perform. Available actions: ${discovery.actions.join(", ")}.`;
  }
  if (!discovery.actions.includes("react")) {
    delete properties.emoji;
    delete properties.remove;
  }
  if (
    !discovery.actions.includes("react") &&
    !discovery.actions.includes("download-file")
  ) {
    delete properties.messageId;
  }
  if (!discovery.actions.includes("upload-file")) {
    delete properties.media;
    delete properties.filename;
    delete properties.title;
  }
  if (!allowProactiveTargets) {
    delete properties.target;
    if (properties.accountId) {
      properties.accountId.description =
        "Optional channel account identifier from the channel notification, used to disambiguate routed replies.";
    }
  }
  return mergeSchemaContributions(schema, discovery.schemaContributions);
}

function pruneProactiveTargetGuidance(description: string): string {
  return description
    .replace(
      /There are two supported send modes:\n- Reply mode: ([^\n]*)\n- Proactive mode:[^\n]*/,
      "Reply mode: $1",
    )
    .replace(MESSAGE_CHANNEL_PARAMETER_LINE("target"), "")
    .replace(
      /\n- Pass exactly one of `chat_id` or `target`\./,
      "\n- Pass `chat_id` from the channel notification.",
    );
}

function pruneInactiveChannelGuidance(
  baseDescription: string,
  activeChannels: SupportedChannelId[],
  actions: string[],
): string {
  let description = baseDescription.trim();
  if (!actions.includes("react")) {
    description = description
      .replace(MESSAGE_CHANNEL_PARAMETER_LINE("emoji"), "")
      .replace(MESSAGE_CHANNEL_PARAMETER_LINE("remove"), "")
      .replace(/\n- `react` should be its own call\./g, "");
  }
  if (!actions.includes("react") && !actions.includes("download-file")) {
    description = description.replace(
      MESSAGE_CHANNEL_PARAMETER_LINE("messageId"),
      "",
    );
  }
  if (!actions.includes("upload-file")) {
    description = description
      .replace(MESSAGE_CHANNEL_PARAMETER_LINE("media"), "")
      .replace(MESSAGE_CHANNEL_PARAMETER_LINE("filename"), "")
      .replace(MESSAGE_CHANNEL_PARAMETER_LINE("title"), "")
      .replace(/\n- `upload-file` can include[^\n]*/g, "");
  }
  if (!activeChannels.includes("telegram")) {
    description = description
      .replace(TELEGRAM_RICH_RULE_RE, "\n")
      .replace(TELEGRAM_RICH_SECTION_RE, "");
  }
  return description.trim();
}

export function buildMessageChannelDescriptionFromDiscovery(
  baseDescription: string,
  discovery: MessageChannelToolDiscoveryResult,
  scoped: boolean,
  allowProactiveTargets = true,
): string {
  const description = (
    allowProactiveTargets
      ? pruneInactiveChannelGuidance(
          baseDescription,
          discovery.activeChannels,
          discovery.actions,
        )
      : pruneProactiveTargetGuidance(
          pruneInactiveChannelGuidance(
            baseDescription,
            discovery.activeChannels,
            discovery.actions,
          ),
        )
  ).trim();
  if (discovery.activeChannels.length === 0) {
    return `${description}\n\nNo external channel adapters are currently running.`;
  }

  const channelList = discovery.displayNames.join(", ");
  const actionList = discovery.actions.join(", ");
  const hasAction = (action: string): boolean =>
    discovery.actions.includes(action);
  const scopedReplyContract = scoped
    ? '\n\nThis tool is currently scoped to a routed external channel turn. Plain assistant text is not delivered to that external user. If a user-visible reply is appropriate, your final action for the turn must be one MessageChannel call with action="send", channel from the notification, chat_id from the notification, and message containing the reply. After that final send succeeds, do not repeat or paraphrase the sent message in assistant text; finish with only `Sent.` as the internal confirmation. This does not apply to a short acknowledgement sent before continuing substantive work. If no user-visible response is appropriate, do not call MessageChannel and do not send an empty acknowledgement. For lightweight acknowledgement, prefer action="react" when supported. If the useful response belongs later, schedule the follow-up instead of sending a placeholder.'
    : "";
  const slackWorkAcknowledgement = discovery.activeChannels.includes("slack")
    ? '\n\nFor Slack requests that require nontrivial work or several tool calls, send one short MessageChannel call with action="send" before starting other tools. This gives the Slack user verbal acknowledgement and a View in web link. Do not do this for no-ops, reaction-only responses, or simple no-tool answers.'
    : "";
  const slackAttachmentDownload =
    discovery.activeChannels.includes("slack") && hasAction("download-file")
      ? '\n\nSlack attachments that exceed the automatic download limit include an exact recovery instruction. Use action="download-file" with channel, chat_id, attachmentId, and messageId from that instruction. The action saves the file in the normal Slack inbound attachment directory and returns its local_path. Downloads that outlast the synchronous window return a task_id instead; wait for the local_path with TaskOutput (block: true, timeout: 600000) or cancel with TaskStop.'
      : "";
  const slackThreadGuidance =
    scoped && discovery.activeChannels.includes("slack")
      ? "\n\nReplies to routed Slack threads stay in the current thread automatically."
      : "";
  const telegramTopicGuidance =
    scoped && discovery.activeChannels.includes("telegram")
      ? "\n\nReplies to routed Telegram topics stay in the current topic automatically."
      : "";
  const slackCapabilities = discovery.activeChannels.includes("slack")
    ? [
        hasAction("react") ? 'action="react" with emoji + messageId' : "",
        hasAction("upload-file") ? 'action="upload-file" with media' : "",
        hasAction("download-file")
          ? 'action="download-file" with attachmentId + messageId'
          : "",
      ].filter(Boolean)
    : [];
  const slackCapabilityGuidance =
    slackCapabilities.length > 0
      ? `\n\nOn Slack, this tool also supports ${slackCapabilities.join(", ")}.`
      : "";
  const telegramCapabilities = discovery.activeChannels.includes("telegram")
    ? '\n\nOn Telegram, this tool also supports action="react" with emoji + messageId and action="upload-file" with media.'
    : "";
  const discordCapabilities = discovery.activeChannels.includes("discord")
    ? '\n\nOn Discord, this tool also supports action="react" with emoji + messageId and action="upload-file" with media. Discord reactions accept native Unicode emoji and custom emoji syntax like <:name:id>.'
    : "";
  const whatsappCapabilities = discovery.activeChannels.includes("whatsapp")
    ? '\n\nOn WhatsApp, this tool also supports action="react" with emoji + messageId and action="upload-file" with media. Voice memo/audio uploads must be Ogg/Opus (.ogg, .oga, or .opus), not MP3/M4A/WAV. Replies are sent as the linked WhatsApp number.'
    : "";
  const signalCapabilities = discovery.activeChannels.includes("signal")
    ? '\n\nOn Signal, this tool also supports action="react" with emoji + messageId and action="upload-file" with media. Replies are sent as the linked Signal account through signal-cli-rest-api.'
    : "";

  return `${description}${scopedReplyContract}${slackThreadGuidance}${telegramTopicGuidance}${slackCapabilityGuidance}${slackWorkAcknowledgement}${slackAttachmentDownload}${telegramCapabilities}${discordCapabilities}${whatsappCapabilities}${signalCapabilities}\n\nCurrently active channels: ${channelList}. Available actions across the active channels: ${actionList}. The JSON schema reflects the currently active channel plugins.`;
}

export function buildMessageChannelToolFromDiscovery(params: {
  baseDescription: string;
  baseSchema: Record<string, unknown>;
  discovery: MessageChannelToolDiscoveryResult;
  scoped: boolean;
  allowProactiveTargets?: boolean;
}): ResolvedMessageChannelToolDefinition {
  return {
    description: buildMessageChannelDescriptionFromDiscovery(
      params.baseDescription,
      params.discovery,
      params.scoped,
      params.allowProactiveTargets,
    ),
    schema: buildMessageChannelSchemaFromDiscovery(
      params.baseSchema,
      params.discovery,
      params.allowProactiveTargets,
    ),
  };
}

/** Build the exact model-facing MessageChannel tool for an external gateway. */
export function buildMessageChannelExternalToolDefinition(
  options: BuildMessageChannelToolOptions,
): ExternalToolDefinitionPayload {
  const resolved = buildMessageChannelToolFromDiscovery({
    baseDescription: MessageChannelDescription.trim(),
    baseSchema: MessageChannelSchema,
    discovery: resolveMessageChannelToolChannels(options.channels),
    scoped: options.scoped,
    allowProactiveTargets: options.allowProactiveTargets ?? false,
  });
  return {
    name: "MessageChannel",
    label: "Message Channel",
    description: resolved.description,
    parameters: resolved.schema,
  };
}
