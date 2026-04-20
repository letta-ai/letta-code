import type {
  ChannelAccount,
  ChannelAdapter,
  ChannelRoute,
  OutboundChannelMessage,
  SupportedChannelId,
} from "./types";

export interface ChannelPluginMetadata {
  id: SupportedChannelId;
  displayName: string;
  runtimePackages: string[];
  runtimeModules: string[];
}

export type ChannelMessageActionName = "send" | "react" | "upload-file";

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
  channel: SupportedChannelId;
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
