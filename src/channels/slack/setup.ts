import { createInterface } from "node:readline/promises";
import { writeChannelConfig } from "../config";
import type { DmPolicy, SlackChannelConfig } from "../types";
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
      "  4. Enable App Home messages and subscribe to app_mention + message.im\n",
    );

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
    console.log("  pairing   — Users must pair with a code (recommended)");
    console.log("  allowlist — Only pre-approved Slack user IDs");
    console.log("  open      — Anyone in DMs can message\n");

    const policyInput = await rl.question("DM policy [pairing]: ");
    const policy = (policyInput.trim() || "pairing") as DmPolicy;
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

    const config: SlackChannelConfig = {
      channel: "slack",
      enabled: true,
      mode: "socket",
      botToken,
      appToken,
      dmPolicy: policy,
      allowedUsers,
    };

    writeChannelConfig("slack", config);
    console.log("\n✓ Slack app configured!");
    console.log("Config written to: ~/.letta/channels/slack/config.yaml\n");
    console.log("Next steps:");
    console.log("  1. Start the listener: letta server --channels slack");
    console.log("  2. DM the app once to generate a pairing code");
    console.log("  3. Mention the app in a Slack channel once to discover it");
    console.log("  4. Bind the DM or channel from Letta Code\n");

    return true;
  } finally {
    rl.close();
  }
}
