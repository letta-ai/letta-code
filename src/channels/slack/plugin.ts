import type { ChannelPlugin } from "@/channels/plugin-types";
import type { ChannelAccount, SlackChannelAccount } from "@/channels/types";
import { SLACK_CHANNEL_CONFIG_SCHEMA } from "./account-config";
import { createSlackAdapter } from "./adapter";
import { slackMessageActions } from "./message-actions";
import { runSlackSetup } from "./setup";

export const slackChannelPlugin: ChannelPlugin = {
  metadata: {
    id: "slack",
    displayName: "Slack",
    runtimePackages: ["@slack/bolt@4.7.0", "@slack/web-api@7.15.0"],
    runtimeModules: ["@slack/bolt", "@slack/web-api"],
    source: "first-party",
    firstParty: true,
    configSchema: SLACK_CHANNEL_CONFIG_SCHEMA,
  },
  createAdapter(account: ChannelAccount) {
    return createSlackAdapter(account as SlackChannelAccount);
  },
  messageActions: slackMessageActions,
  runSetup() {
    return runSlackSetup();
  },
};
