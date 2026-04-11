import type { ChannelPlugin } from "../pluginTypes";
import type { ChannelConfig, SlackChannelConfig } from "../types";
import { createSlackAdapter } from "./adapter";
import { runSlackSetup } from "./setup";

export const slackChannelPlugin: ChannelPlugin = {
  metadata: {
    id: "slack",
    displayName: "Slack",
    runtimePackages: ["@slack/bolt@4.7.0"],
    runtimeModules: ["@slack/bolt"],
  },
  createAdapter(config: ChannelConfig) {
    return createSlackAdapter(config as SlackChannelConfig);
  },
  runSetup() {
    return runSlackSetup();
  },
};
