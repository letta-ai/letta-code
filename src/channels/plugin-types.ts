import type {
  ChannelAccount,
  ChannelAdapter,
  ChannelChatType,
  ChannelDefaultPermissionMode,
  ChannelRoute,
  DiscordChannelMode,
  DmPolicy,
  OutboundChannelMessage,
  SignalGroupMode,
  SlackAllowBotsMode,
  SlackChannelMode,
  TelegramGroupMode,
  WhatsAppGroupMode,
} from "./types";

export interface ChannelPluginMetadata {
  id: string;
  displayName: string;
  runtimePackages: string[];
  runtimeModules: string[];
  source?: "first-party" | "user";
  firstParty?: boolean;
  /**
   * Optional declarative description of the plugin's account-config fields.
   * When present, clients can render a dynamic settings form instead of
   * relying on free-form JSON textareas. Surfaced to clients via
   * `channels_list_response.channels[*].config_schema`.
   */
  configSchema?: ChannelConfigSchema;
}

export type ChannelConfigFieldType =
  | "text"
  | "secret"
  | "select"
  | "boolean"
  | "number"
  | "string-array"
  | "key-value-map";

export interface ChannelConfigFieldBase {
  /** Snake-case key used in the plugin's stored config payload. */
  key: string;
  label: string;
  description?: string;
  required?: boolean;
  /**
   * Advisory UI hint: when true the dialog renders a "restart required"
   * chip near the field. Does not yet enforce restart semantics — that's
   * future work. Plugins should still document which fields they hot-read
   * vs. read once at startup.
   */
  restartRequired?: boolean;
  /**
   * Where this field lives in the storage model:
   *   - 'app' (default): stored on the app's plugin config, shared across
   *     all accounts. Rendered in the App settings tab.
   *   - 'account': stored on each individual account (e.g. credentials,
   *     per-handle identifiers). Rendered in the Accounts tab. The App
   *     settings form omits these fields entirely.
   * If unspecified, treat as 'app' to preserve backwards compatibility.
   */
  scope?: "app" | "account";
}

export interface ChannelConfigTextField extends ChannelConfigFieldBase {
  type: "text";
  default?: string;
  placeholder?: string;
}

export interface ChannelConfigSecretField extends ChannelConfigFieldBase {
  type: "secret";
  placeholder?: string;
}

export interface ChannelConfigSelectOption {
  value: string;
  label: string;
}

export interface ChannelConfigSelectField extends ChannelConfigFieldBase {
  type: "select";
  options: ChannelConfigSelectOption[];
  default?: string;
}

export interface ChannelConfigBooleanField extends ChannelConfigFieldBase {
  type: "boolean";
  default?: boolean;
}

export interface ChannelConfigNumberField extends ChannelConfigFieldBase {
  type: "number";
  default?: number;
  /** Inclusive lower bound (validated server-side + UI-rendered). */
  min?: number;
  /** Inclusive upper bound. */
  max?: number;
  /** Step granularity for the UI input (e.g. 0.05). */
  step?: number;
  /** Trailing adornment text rendered after the input (e.g. "ms", "%"). */
  suffix?: string;
  placeholder?: string;
}

export interface ChannelConfigStringArrayField extends ChannelConfigFieldBase {
  type: "string-array";
  default?: string[];
  /** Placeholder shown inside each row's input. */
  placeholder?: string;
}

export interface ChannelConfigKeyValueMapField extends ChannelConfigFieldBase {
  type: "key-value-map";
  /** Whether row values are typed strings or numbers. */
  valueType: "string" | "number";
  default?: Record<string, string | number>;
  /** Column-header labels for the key/value columns. */
  keyLabel?: string;
  valueLabel?: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

export type ChannelConfigField =
  | ChannelConfigTextField
  | ChannelConfigSecretField
  | ChannelConfigSelectField
  | ChannelConfigBooleanField
  | ChannelConfigNumberField
  | ChannelConfigStringArrayField
  | ChannelConfigKeyValueMapField;

export interface ChannelConfigSchema {
  version: 1;
  fields: ChannelConfigField[];
}

export type ChannelProtocolConfig = Record<string, unknown>;

export interface ChannelCommonAccountPatch {
  displayName?: string;
  enabled?: boolean;
  dmPolicy?: DmPolicy;
  allowedUsers?: string[];
}

export interface ChannelPluginAccountPatch {
  // Built-in channel account patches are intentionally flattened here because
  // the channels service applies plugin config through one shared
  // create/update path. ChannelAccountConfigAdapter maps protocol snake_case
  // config into these camelCase fields before the service builds the concrete
  // account type. This is channel-specific today; a future cleanup can replace
  // this bag with discriminated per-channel patch types.
  token?: string;
  botToken?: string;
  appToken?: string;
  mode?: SlackChannelMode;
  groupMode?: TelegramGroupMode | WhatsAppGroupMode | SignalGroupMode;
  agentId?: string | null;
  baseUrl?: string;
  account?: string;
  accountUuid?: string;
  defaultPermissionMode?: ChannelDefaultPermissionMode;
  allowedChannels?: string[] | Record<string, DiscordChannelMode>;
  autoThreadOnMention?: boolean;
  threadPolicyByChannel?: Record<string, boolean>;
  acknowledgeMessageReaction?: boolean;
  listenMode?: boolean;
  allowBots?: SlackAllowBotsMode;
  removeStaleRoutes?: boolean;
  inboundDebounceMs?: number;
  selfChatMode?: boolean;
  allowedGroups?: string[];
  mentionPatterns?: string[];
  /** Signal UUID/identity -> replyable recipient aliases, e.g. UUID to E.164 phone. */
  recipientAliases?: Record<string, string>;
  transcribeVoice?: boolean;
  richPrivateChatDefault?: boolean;
  richDraftStreaming?: boolean;
  downloadMedia?: boolean;
  mediaMaxBytes?: number;
  messagePrefix?: string;
  waitingBehavior?: import("./types").WhatsAppWaitingBehavior;
}

export type ChannelAccountPatch = ChannelCommonAccountPatch &
  ChannelPluginAccountPatch & {
    /** Plugin-owned snake_case config accepted from the websocket protocol. */
    config?: ChannelProtocolConfig;
  };

export type ChannelConfigPatch = Pick<
  ChannelCommonAccountPatch,
  "dmPolicy" | "allowedUsers"
> &
  ChannelPluginAccountPatch & {
    /** Plugin-owned snake_case config accepted from the websocket protocol. */
    config?: ChannelProtocolConfig;
  };

export interface ChannelAccountConfigAdapter<TAccount extends ChannelAccount> {
  /** Validate plugin-owned config payloads. */
  isValidConfig(config: ChannelProtocolConfig): boolean;
  /** Convert protocol snake_case config into the internal account patch shape. */
  toAccountPatch(config: ChannelProtocolConfig): ChannelPluginAccountPatch;
  /** Redacted/safe plugin config included in account list/get responses. */
  toAccountConfig(account: TAccount): ChannelProtocolConfig;
  /** Redacted/safe plugin config included in channel_get_config responses. */
  toConfigSnapshotConfig(account: TAccount): ChannelProtocolConfig;
  /** Whether this plugin config patch changes credentials/display identity. */
  shouldRefreshDisplayName(patch: ChannelPluginAccountPatch): boolean;
}

export type ChannelMessageActionName = string;

export interface ChannelMessageToolSchemaContribution {
  properties: Record<string, unknown>;
  visibility?: "all-configured";
}

/**
 * Plugin-owned discovery for the shared MessageChannel tool.
 * Channel plugins advertise their supported actions and any extra schema
 * fragments here so the public tool surface stays singular while the
 * capabilities remain channel-specific.
 */
export interface ChannelMessageToolDiscovery {
  actions?: readonly ChannelMessageActionName[] | null;
  schema?:
    | ChannelMessageToolSchemaContribution
    | ChannelMessageToolSchemaContribution[]
    | null;
}

export interface ChannelMessageActionRequest {
  action: ChannelMessageActionName;
  channel: string;
  chatId: string;
  message?: string;
  replyToMessageId?: string;
  threadId?: string | null;
  messageId?: string;
  attachmentId?: string;
  emoji?: string;
  remove?: boolean;
  mediaPath?: string;
  filename?: string;
  title?: string;
}

export interface ChannelResolvedMessageTarget {
  chatId: string;
  chatType?: ChannelChatType;
  threadId?: string | null;
  label?: string;
}

export interface ChannelMessageActionContext {
  request: ChannelMessageActionRequest;
  route: ChannelRoute;
  adapter: ChannelAdapter;
  /**
   * Format user-authored markdown/plain text for the target channel before the
   * plugin sends it. The shared MessageChannel tool owns cross-channel text
   * normalization, while action adapters decide how to pass the result to their
   * concrete ChannelAdapter (e.g. Telegram HTML, Slack mrkdwn, Signal styles).
   */
  formatText: (
    text: string,
  ) => Pick<OutboundChannelMessage, "text" | "parseMode" | "textStyle">;
}

/**
 * Channel-owned action surface for the shared MessageChannel tool.
 * This mirrors the OpenClaw pattern: one top-level tool, with each channel
 * plugin owning action discovery and execution underneath it.
 */
export interface ChannelMessageActionAdapter {
  describeMessageTool(params: {
    accountId?: string | null;
  }): ChannelMessageToolDiscovery;
  resolveMessageTarget?(params: {
    account: ChannelAccount;
    target: string;
  }): Promise<ChannelResolvedMessageTarget>;
  handleAction(ctx: ChannelMessageActionContext): Promise<string>;
}

export interface ChannelPlugin {
  metadata: ChannelPluginMetadata;
  createAdapter(
    account: ChannelAccount,
  ): Promise<ChannelAdapter> | ChannelAdapter;
  runSetup?(): Promise<boolean>;
  resolveAccountDisplayName?(
    account: ChannelAccount,
  ): Promise<string | undefined> | string | undefined;
  messageActions?: ChannelMessageActionAdapter;
}
