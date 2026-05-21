import type {
  ChannelConfigSchema,
  ChannelPlugin,
} from "@/channels/plugin-types";
import type { ChannelAccount, CustomChannelAccount } from "@/channels/types";
import { createCustomAdapter } from "./adapter";

/**
 * Declarative config schema for the custom channel.
 * Matches the field set used by CustomManageDialog so the desktop UI can
 * render a dynamic form when it receives this schema from
 * `channels_list_response`.
 */
export const CUSTOM_CHANNEL_CONFIG_SCHEMA: ChannelConfigSchema = {
  version: 1,
  fields: [
    {
      type: "text",
      key: "url",
      label: "Webhook URL",
      required: true,
      placeholder: "https://example.com/webhook",
      description: "Letta Code will POST incoming agent messages to this URL.",
    },
    {
      type: "secret",
      key: "bot_token",
      label: "Bot token",
      placeholder: "Paste your bot token",
      description:
        "Used to authenticate Letta Code as a bot when posting to your service.",
    },
    {
      type: "secret",
      key: "auth",
      label: "Auth token",
      placeholder: "Optional secret or bearer token",
      description:
        "Optional. Used to authenticate requests sent to your webhook URL.",
    },
    {
      type: "text",
      key: "agent_id",
      label: "Connected agent",
    },
    {
      type: "text",
      key: "accounts_json",
      label: "Accounts (JSON)",
    },
    {
      type: "text",
      key: "configs_json",
      label: "Config (JSON)",
    },
    {
      type: "text",
      key: "metadata_json",
      label: "Metadata (JSON)",
    },
  ],
};

export const customChannelPlugin: ChannelPlugin = {
  metadata: {
    id: "custom",
    displayName: "Custom",
    runtimePackages: [],
    runtimeModules: [],
    source: "first-party",
    firstParty: true,
    configSchema: CUSTOM_CHANNEL_CONFIG_SCHEMA,
  },
  createAdapter(account: ChannelAccount) {
    return createCustomAdapter(account as CustomChannelAccount);
  },
};
