import type {
  ChannelAdapter,
  ChannelConfig,
  SupportedChannelId,
} from "./types";

export interface ChannelPluginMetadata {
  id: SupportedChannelId;
  displayName: string;
  runtimePackages: string[];
  runtimeModules: string[];
}

export interface ChannelPlugin {
  metadata: ChannelPluginMetadata;
  createAdapter(
    config: ChannelConfig,
  ): Promise<ChannelAdapter> | ChannelAdapter;
  runSetup?(): Promise<boolean>;
}
