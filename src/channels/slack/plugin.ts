import type { ChannelPlugin } from "@/channels/plugin-types";
import type { ChannelAccount, SlackChannelAccount } from "@/channels/types";
import { resolveSlackAccountDisplayName } from "./account-display";
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
  },
  createAdapter(account: ChannelAccount) {
    return createSlackAdapter(account as SlackChannelAccount);
  },
  resolveAccountDisplayName(account: ChannelAccount) {
    const slack = account as SlackChannelAccount;
    if (!slack.botToken.trim() || !slack.appToken.trim()) return undefined;
    return resolveSlackAccountDisplayName(slack.botToken, slack.appToken);
  },
  messageActions: slackMessageActions,
  runSetup() {
    return runSlackSetup();
  },
};
