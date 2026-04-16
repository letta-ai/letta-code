import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { upsertChannelAccount } from "../accounts";
import type { DiscordChannelAccount, DmPolicy } from "../types";
import { ensureDiscordRuntimeInstalled } from "./runtime";

function isValidBotToken(token: string): boolean {
  // Discord bot tokens are base64-encoded and typically 59-72 chars
  return token.length >= 50 && token.includes(".");
}

export async function runDiscordSetup(): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("\n🎮 Discord Bot Setup\n");
    console.log("You'll need a Discord bot application with a bot token.");
    console.log("Recommended setup:");
    console.log("  1. Create an application at https://discord.com/developers");
    console.log("  2. Go to Bot settings and create a bot");
    console.log(
      "  3. Enable the MESSAGE CONTENT privileged intent under Bot settings",
    );
    console.log("  4. Copy the bot token");
    console.log(
      "  5. Invite the bot to your server using OAuth2 URL Generator",
    );
    console.log("     Required scopes: bot");
    console.log(
      "     Required permissions: Send Messages, Read Message History, Add Reactions, Create Public Threads, Send Messages in Threads, Attach Files\n",
    );

    await ensureDiscordRuntimeInstalled();

    const token = (await rl.question("Enter your Discord bot token: ")).trim();
    if (!isValidBotToken(token)) {
      console.error("Invalid Discord bot token.");
      return false;
    }

    console.log("\nDM Policy — who can message this bot directly?\n");
    console.log("  pairing   — Require a pairing code (recommended)");
    console.log("  allowlist — Only pre-approved Discord user IDs");
    console.log("  open      — Anyone who can DM the bot\n");

    const policyInput = await rl.question("DM policy [pairing]: ");
    const policy = (policyInput.trim() || "pairing") as DmPolicy;
    if (!["pairing", "allowlist", "open"].includes(policy)) {
      console.error(`Invalid policy "${policy}". Setup cancelled.`);
      return false;
    }

    let allowedUsers: string[] = [];
    if (policy === "allowlist") {
      const usersInput = await rl.question(
        "Enter allowed Discord user IDs (comma-separated): ",
      );
      allowedUsers = usersInput
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    }

    const now = new Date().toISOString();
    const account: DiscordChannelAccount = {
      channel: "discord",
      accountId: randomUUID(),
      enabled: true,
      token,
      agentId: null,
      dmPolicy: policy,
      allowedUsers,
      createdAt: now,
      updatedAt: now,
    };

    upsertChannelAccount("discord", account);
    console.log("\n✓ Discord bot configured!");
    console.log("Config written to: ~/.letta/channels/discord/accounts.json\n");
    console.log("Next steps:");
    console.log("  1. Start the listener: letta server --channels discord");
    console.log("  2. Open Channels > Discord in Letta Code");
    console.log(
      "  3. Choose which Letta agent this Discord bot should represent",
    );
    console.log(
      "  4. DM the bot or @mention it in a Discord server to start chatting\n",
    );

    return true;
  } finally {
    rl.close();
  }
}
