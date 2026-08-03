import type {
  ChannelConfigSchema,
  ChannelPlugin,
} from "@/channels/plugin-types";
import type { ChannelAccount } from "@/channels/types";
import { isCustomChannelAccount } from "@/channels/types";
import { createLinearAdapter } from "./adapter";
import { createLinearClient } from "./client";
import { linearMessageActions } from "./message-actions";
import { displayLinearPerson } from "./notification";
import { runLinearSetup } from "./setup";

export const LINEAR_CHANNEL_CONFIG_SCHEMA: ChannelConfigSchema = {
  version: 1,
  fields: [
    {
      type: "secret",
      key: "auth",
      label: "Linear personal API key",
      description:
        "Used to read this Linear account's notifications and post agent comments.",
      required: true,
      scope: "account",
      restartRequired: true,
    },
    {
      type: "text",
      key: "agent_id",
      label: "Connected agent",
      description: "New Linear issue conversations are created for this agent.",
      required: true,
      scope: "account",
      restartRequired: true,
    },
    {
      type: "number",
      key: "poll_interval_ms",
      label: "Poll interval",
      description: "How often to check the Linear notification inbox.",
      default: 5000,
      min: 1000,
      max: 60000,
      step: 1000,
      suffix: "ms",
      scope: "account",
      restartRequired: true,
    },
    {
      type: "boolean",
      key: "reply_enabled",
      label: "Allow comment replies",
      description:
        "Allow MessageChannel to post comments through this account.",
      default: true,
      scope: "account",
      restartRequired: true,
    },
  ],
};

export const linearChannelPlugin: ChannelPlugin = {
  metadata: {
    id: "linear",
    displayName: "Linear (Experimental)",
    runtimePackages: [],
    runtimeModules: [],
    source: "bundled",
    firstParty: false,
    configSchema: LINEAR_CHANNEL_CONFIG_SCHEMA,
  },

  createAdapter(account: ChannelAccount) {
    return createLinearAdapter(account);
  },

  async resolveAccountDisplayName(account: ChannelAccount) {
    if (!isCustomChannelAccount(account) || account.channel !== "linear") {
      return undefined;
    }
    const auth = account.config.auth;
    if (typeof auth !== "string" || !auth.trim()) return undefined;
    const viewer = await createLinearClient(auth).getViewer();
    return `${displayLinearPerson(viewer)}${viewer.organization?.name ? ` (${viewer.organization.name})` : ""}`;
  },

  messageActions: linearMessageActions,

  runSetup() {
    return runLinearSetup();
  },
};
