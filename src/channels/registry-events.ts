import type { ChannelDefaultPermissionMode } from "./types";

export type ChannelRegistryEvent =
  | {
      type: "pairings_updated";
      channelId: string;
    }
  | {
      type: "targets_updated";
      channelId: string;
    }
  | {
      type: "channel_account_state_updated";
      channelId: string;
      accountId: string;
    }
  | {
      type: "slack_conversation_created";
      channelId: "slack";
      accountId: string;
      agentId: string;
      conversationId: string;
      defaultPermissionMode: ChannelDefaultPermissionMode;
    }
  | {
      type: "discord_conversation_created";
      channelId: "discord";
      accountId: string;
      agentId: string;
      conversationId: string;
      defaultPermissionMode: ChannelDefaultPermissionMode;
    };
