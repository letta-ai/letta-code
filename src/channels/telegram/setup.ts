/**
 * Telegram bot setup wizard for `letta channels configure telegram`.
 *
 * Interactive CLI flow:
 * 1. Prompt for bot token from @BotFather
 * 2. Validate via getMe()
 * 3. Choose DM policy
 * 4. Write config to ~/.letta/channels/telegram/config.yaml
 */

import { createInterface } from "node:readline/promises";
import { writeChannelConfig } from "../config";
import type { DmPolicy, TelegramChannelConfig } from "../types";
import { validateTelegramToken } from "./adapter";

export async function runTelegramSetup(): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("\n🤖 Telegram Bot Setup\n");
    console.log("You'll need a bot token from @BotFather on Telegram.");
    console.log("Create one by messaging @BotFather and using /newbot.\n");

    // Step 1: Get token
    const token = await rl.question("Enter your Telegram bot token: ");
    if (!token.trim()) {
      console.error("No token provided. Setup cancelled.");
      return false;
    }

    // Step 2: Validate token
    console.log("\nValidating token...");
    try {
      const info = await validateTelegramToken(token.trim());
      console.log(`✓ Connected to @${info.username} (ID: ${info.id})\n`);
    } catch (err) {
      console.error(
        `✗ Invalid token: ${err instanceof Error ? err.message : "unknown error"}`,
      );
      return false;
    }

    // Step 3: Choose DM policy
    console.log("DM Policy — who can message this bot?\n");
    console.log("  pairing   — Users must pair with a code (recommended)");
    console.log("  allowlist — Only pre-approved user IDs");
    console.log("  open      — Anyone can message\n");

    const policyInput = await rl.question("DM policy [pairing]: ");
    const policy = (policyInput.trim() || "pairing") as DmPolicy;

    if (!["pairing", "allowlist", "open"].includes(policy)) {
      console.error(`Invalid policy "${policy}". Setup cancelled.`);
      return false;
    }

    // Step 4: Allowlist if needed
    let allowedUsers: string[] = [];
    if (policy === "allowlist") {
      const usersInput = await rl.question(
        "Enter allowed Telegram user IDs (comma-separated): ",
      );
      allowedUsers = usersInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    // Step 5: Write config
    const config: TelegramChannelConfig = {
      channel: "telegram",
      enabled: true,
      token: token.trim(),
      dmPolicy: policy,
      allowedUsers,
    };

    writeChannelConfig("telegram", config);
    console.log("\n✓ Telegram bot configured!");
    console.log("Start with: letta server --channels telegram\n");

    return true;
  } finally {
    rl.close();
  }
}
