import type {
  ChannelAccount,
  ChannelAdapter,
  ChannelChatType,
  ChannelRoute,
  DmPolicy,
  OutboundChannelMessage,
  SlackChannelMode,
  SlackDefaultPermissionMode,
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

export type ChannelConfigFieldType = "text" | "secret" | "select" | "boolean";

export interface ChannelConfigFieldBase {
  /** Snake-case key used in the plugin's stored config payload. */
  key: string;
  label: string;
  description?: string;
  required?: boolean;
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

export type ChannelConfigField =
  | ChannelConfigTextField
  | ChannelConfigSecretField
  | ChannelConfigSelectField
  | ChannelConfigBooleanField;

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
  token?: string;
  botToken?: string;
  appToken?: string;
  mode?: SlackChannelMode;
  agentId?: string | null;
  defaultPermissionMode?: SlackDefaultPermissionMode;
  allowedChannels?: string[];
  transcribeVoice?: boolean;
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
  formatText: (
    text: string,
  ) => Pick<OutboundChannelMessage, "text" | "parseMode">;
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
  messageActions?: ChannelMessageActionAdapter;
}
