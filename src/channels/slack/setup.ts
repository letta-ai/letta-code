import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { upsertChannelAccount } from "../accounts";
import type { DmPolicy, SlackChannelAccount } from "../types";
import { resolveSlackAccountDisplayName } from "./adapter";
import { ensureSlackRuntimeInstalled } from "./runtime";

function isValidBotToken(token: string): boolean {
  return token.startsWith("xoxb-") && token.length >= 20;
}

function isValidAppToken(token: string): boolean {
  return token.startsWith("xapp-") && token.length >= 20;
}

export async function runSlackSetup(): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("\n💬 Slack App Setup\n");
    console.log("You'll need a Slack app configured for Socket Mode.");
    console.log("Recommended setup:");
    console.log("  1. Create a Slack app for your workspace");
    console.log("  2. Enable Socket Mode and generate an app token (xapp-...)");
    console.log(
      "  3. Install the app to the workspace to get a bot token (xoxb-...)",
    );
    console.log(
      "  4. Enable App Home messages and subscribe to app_mention + message.channels + message.groups + message.im + reaction_added + reaction_removed\n",
    );
    console.log("Recommended bot token scopes:");
    console.log(
      "  app_mentions:read, channels:history, chat:write, groups:history, im:history, users:read",
    );
    console.log("  reactions:read, reactions:write, files:read, files:write\n");

    await ensureSlackRuntimeInstalled();

    const botToken = (
      await rl.question("Enter your Slack bot token (xoxb-...): ")
    ).trim();
    if (!isValidBotToken(botToken)) {
      console.error("Invalid Slack bot token. Expected an xoxb- token.");
      return false;
    }

    const appToken = (
      await rl.question("Enter your Slack app token (xapp-...): ")
    ).trim();
    if (!isValidAppToken(appToken)) {
      console.error("Invalid Slack app token. Expected an xapp- token.");
      return false;
    }

    console.log("\nDM Policy — who can message this app directly?\n");
    console.log("  allowlist — Only pre-approved Slack user IDs");
    console.log("  open      — Anyone in DMs can message (recommended)\n");

    const policyInput = await rl.question("DM policy [open]: ");
    const policy = (policyInput.trim() || "open") as DmPolicy;
    if (!["pairing", "allowlist", "open"].includes(policy)) {
      console.error(`Invalid policy "${policy}". Setup cancelled.`);
      return false;
    }

    let allowedUsers: string[] = [];
    if (policy === "allowlist") {
      const usersInput = await rl.question(
        "Enter allowed Slack user IDs (comma-separated): ",
      );
      allowedUsers = usersInput
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    }

    const now = new Date().toISOString();
    let displayName: string | undefined;
    try {
      displayName = await resolveSlackAccountDisplayName(botToken, appToken);
    } catch {}

    const account: SlackChannelAccount = {
      channel: "slack",
      accountId: randomUUID(),
      displayName,
      enabled: true,
      mode: "socket",
      botToken,
      appToken,
      agentId: null,
      dmPolicy: policy,
      allowedUsers,
      createdAt: now,
      updatedAt: now,
    };

    upsertChannelAccount("slack", account);
    console.log("\n✓ Slack app configured!");
    console.log("Config written to: ~/.letta/channels/slack/accounts.json\n");
    console.log("Next steps:");
    console.log("  1. Start the listener: letta server --channels slack");
    console.log("  2. Open Channels > Slack in Letta Code");
    console.log(
      "  3. Choose which Letta agent this Slack app should represent",
    );
    console.log("  4. DM the app or @mention it in Slack to start chatting\n");

    return true;
  } finally {
    rl.close();
  }
}
