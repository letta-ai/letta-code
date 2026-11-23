import type { ChannelSendBindingInfo } from "./message-channel-bindings";
import type {
  ChannelAccount,
  ChannelAdapter,
  ChannelAllowBotsMode,
  ChannelChatType,
  ChannelDefaultPermissionMode,
  ChannelRoute,
  DiscordChannelMode,
  DmPolicy,
  OutboundChannelMessage,
  SignalGroupMode,
  SlackChannelMode,
  TelegramGroupMode,
  WhatsAppGroupMode,
} from "./types";
import type { WhatsAppWaitingBehavior } from "./whatsapp/waiting-behavior-config-types";

export interface ChannelPluginMetadata {
  id: string;
  displayName: string;
  runtimePackages: string[];
  runtimeModules: string[];
  source?: "first-party" | "user";
  firstParty?: boolean;
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
  key: string;
  label: string;
  description?: string;
  required?: boolean;
  restartRequired?: boolean;
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
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  placeholder?: string;
}

export interface ChannelConfigStringArrayField extends ChannelConfigFieldBase {
  type: "string-array";
  default?: string[];
  placeholder?: string;
}

export interface ChannelConfigKeyValueMapField extends ChannelConfigFieldBase {
  type: "key-value-map";
  valueType: "string" | "number";
  default?: Record<string, string | number>;
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
  mentionOnlyChannels?: string[];
  allowBots?: ChannelAllowBotsMode;
  removeStaleRoutes?: boolean;
  inboundDebounceMs?: number;
  messagePrefix?: string;
  selfChatMode?: boolean;
  allowedGroups?: string[];
  mentionPatterns?: string[];
  recipientAliases?: Record<string, string>;
  transcribeVoice?: boolean;
  richPrivateChatDefault?: boolean;
  richDraftStreaming?: boolean;
  downloadMedia?: boolean;
  mediaMaxBytes?: number;
  attachmentFilter?: boolean;
  attachmentMimeTypes?: string[];
  attachmentAllowedRecipients?: string[];
  attachmentAllowedPaths?: string[];
  attachmentPathRecursive?: boolean;
  waitingBehavior?: WhatsAppWaitingBehavior;
}

export type ChannelAccountPatch = ChannelCommonAccountPatch &
  ChannelPluginAccountPatch & {
    config?: ChannelProtocolConfig;
  };

export type ChannelConfigPatch = Pick<
  ChannelCommonAccountPatch,
  "dmPolicy" | "allowedUsers"
> &
  ChannelPluginAccountPatch & {
    config?: ChannelProtocolConfig;
  };

export interface ChannelAccountConfigAdapter<TAccount extends ChannelAccount> {
  isValidConfig(config: ChannelProtocolConfig): boolean;
  toAccountPatch(config: ChannelProtocolConfig): ChannelPluginAccountPatch;
  toAccountConfig(account: TAccount): ChannelProtocolConfig;
  toConfigSnapshotConfig(account: TAccount): ChannelProtocolConfig;
  shouldRefreshDisplayName(patch: ChannelPluginAccountPatch): boolean;
}

export type ChannelMessageActionName = string;

export interface ChannelMessageActionResult {
  messageId: string;
  bindingInfo?: ChannelSendBindingInfo;
}

export interface ChannelMessageToolSchemaContribution {
  properties: Record<string, unknown>;
  visibility?: "all-configured";
}

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

export type ChannelMessageActionTransport = Pick<
  ChannelAdapter,
  "downloadAttachment" | "listCustomEmojis"
> & {
  sendMessage(
    message: OutboundChannelMessage,
  ): Promise<ChannelMessageActionResult>;
};

export type ChannelMessageActionRoute = Pick<
  ChannelRoute,
  | "accountId"
  | "chatId"
  | "chatType"
  | "threadId"
  | "agentId"
  | "conversationId"
>;

export interface ChannelMessageActionContext {
  request: ChannelMessageActionRequest;
  route: ChannelMessageActionRoute;
  adapter: ChannelMessageActionTransport;
  formatText: (
    text: string,
  ) => Pick<OutboundChannelMessage, "text" | "parseMode" | "textStyle">;
}

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
