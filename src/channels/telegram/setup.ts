/**
 * Telegram bot setup wizard for `letta channels configure telegram`.
 *
 * Interactive CLI flow:
 * 1. Prompt for bot token from @BotFather
 * 2. Validate via getMe()
 * 3. Choose DM policy
 * 4. Write config to ~/.letta/channels/telegram/accounts.json
 * 5. Start `letta server --channels telegram`
 * 6. Message the bot from Telegram to get a pairing code
 * 7. Run `/channels telegram pair <code>` in the target ADE/Desktop conversation
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { upsertChannelAccount } from "../accounts";
import type { DmPolicy, TelegramChannelAccount } from "../types";
import { validateTelegramToken } from "./adapter";
import { ensureTelegramRuntimeInstalled } from "./runtime";

export async function runTelegramSetup(): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("\n🤖 Telegram Bot Setup\n");
    console.log("You'll need a bot token from @BotFather on Telegram.");
    console.log("Create one by messaging @BotFather and using /newbot.\n");

    await ensureTelegramRuntimeInstalled();

    // Step 1: Get token
    const token = await rl.question("Enter your Telegram bot token: ");
    if (!token.trim()) {
      console.error("No token provided. Setup cancelled.");
      return false;
    }

    // Step 2: Validate token
    console.log("\nValidating token...");
    let validatedUsername: string | undefined;
    try {
      const info = await validateTelegramToken(token.trim());
      validatedUsername = info.username;
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

    const transcriptionInput = await rl.question(
      "Auto-transcribe voice memos when OPENAI_API_KEY is set? [y/N]: ",
    );
    const transcribeVoice = /^(y|yes)$/i.test(transcriptionInput.trim());

    // Step 5: Write account
    const now = new Date().toISOString();
    const account: TelegramChannelAccount = {
      channel: "telegram",
      accountId: randomUUID(),
      displayName: validatedUsername ? `@${validatedUsername}` : undefined,
      enabled: true,
      token: token.trim(),
      dmPolicy: policy,
      allowedUsers,
      transcribeVoice,
      binding: {
        agentId: null,
        conversationId: null,
      },
      createdAt: now,
      updatedAt: now,
    };

    upsertChannelAccount("telegram", account);
    console.log("\n✓ Telegram bot configured!");
    console.log(
      "Config written to: ~/.letta/channels/telegram/accounts.json\n",
    );
    console.log("Next steps:");
    console.log("  1. Start the listener: letta server --channels telegram");
    console.log("  2. Message the bot from Telegram to get a pairing code");
    console.log(
      "  3. In the target ADE/Desktop conversation, run: /channels telegram pair <code>\n",
    );

    return true;
  } catch (error) {
    console.error(
      `Setup failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return false;
  } finally {
    rl.close();
  }
}
