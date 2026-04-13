import type { ChannelPlugin } from "../pluginTypes";
import type { ChannelAccount, SlackChannelAccount } from "../types";
import { createSlackAdapter } from "./adapter";
import { slackMessageActions } from "./messageActions";
import { runSlackSetup } from "./setup";

export const slackChannelPlugin: ChannelPlugin = {
  metadata: {
    id: "slack",
    displayName: "Slack",
    runtimePackages: ["@slack/bolt@4.7.0"],
    runtimeModules: ["@slack/bolt"],
  },
  createAdapter(account: ChannelAccount) {
    return createSlackAdapter(account as SlackChannelAccount);
  },
  messageActions: slackMessageActions,
  runSetup() {
    return runSlackSetup();
  },
};
