import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { upsertChannelAccount } from "../accounts";
import type {
  DiscordChannelAccount,
  DiscordChannelMode,
  DmPolicy,
} from "../types";
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

    console.log("\nGuild channel behavior — when should the bot respond?\n");
    console.log(
      "  mention-only — Respond only when @mentioned, or in an existing routed thread (recommended)",
    );
    console.log(
      "  open         — Respond to every message in selected channels\n",
    );
    const modeInput = await rl.question("Guild channel mode [mention-only]: ");
    const channelMode = (modeInput.trim() ||
      "mention-only") as DiscordChannelMode;
    if (!["mention-only", "open"].includes(channelMode)) {
      console.error(`Invalid guild channel mode "${channelMode}".`);
      return false;
    }

    let allowedChannels: DiscordChannelAccount["allowedChannels"] | undefined;
    if (channelMode === "open") {
      const channelsInput = await rl.question(
        "Discord channel IDs to run in open mode (comma-separated, required): ",
      );
      const channelIds = channelsInput
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (channelIds.length === 0) {
        console.error("At least one channel ID is required for open mode.");
        return false;
      }
      allowedChannels = Object.fromEntries(
        channelIds.map((channelId) => [channelId, "open"]),
      );
    } else {
      const channelsInput = await rl.question(
        "Optional Discord channel IDs to allowlist for mention-only mode (comma-separated, blank for all): ",
      );
      const channelIds = channelsInput
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      allowedChannels = channelIds.length > 0 ? channelIds : undefined;
    }

    const autoThreadInput = await rl.question(
      "\nAuto-create a thread when @mentioned in a guild channel? [y/N]: ",
    );
    const autoThreadOnMention = /^(y|yes)$/i.test(autoThreadInput.trim());

    const debounceInput = await rl.question(
      "Inbound debounce for open-channel messages in ms [0]: ",
    );
    const parsedDebounce = Number(debounceInput.trim() || "0");
    if (!Number.isFinite(parsedDebounce) || parsedDebounce < 0) {
      console.error("Invalid debounce window. Use a non-negative number.");
      return false;
    }
    const inboundDebounceMs = Math.trunc(Math.min(parsedDebounce, 10000));

    const reactionsInput = await rl.question(
      "Send 👀/✅ reaction acknowledgments? [y/N]: ",
    );
    const acknowledgeMessageReaction = /^(y|yes)$/i.test(reactionsInput.trim());

    const transcriptionInput = await rl.question(
      "Auto-transcribe audio attachments when OPENAI_API_KEY is set? [y/N]: ",
    );
    const transcribeVoice = /^(y|yes)$/i.test(transcriptionInput.trim());

    // Agent binding — required for account-bound DMs and guild @mentions.
    // Without this, the bot won't know which agent to create conversations for.
    const envAgentId = process.env.LETTA_AGENT_ID || "";
    let agentId: string | null = null;

    if (envAgentId) {
      const useEnv = await rl.question(
        `\nBind to agent ${envAgentId}? [Y/n]: `,
      );
      if (!useEnv.trim() || useEnv.trim().toLowerCase() === "y") {
        agentId = envAgentId;
      }
    }

    if (!agentId) {
      const agentInput = await rl.question(
        "\nAgent ID to bind this bot to (required for DM and @mention routing): ",
      );
      agentId = agentInput.trim() || null;
    }

    if (!agentId) {
      console.log(
        "\nWarning: No agent bound. DM pairing will still work, but open/allowlist DMs and guild @mentions won't route until you bind an agent.",
      );
      console.log(
        "  You can bind later: letta channels bind --channel discord --agent <id>",
      );
      console.log(
        "  Or set agentId in ~/.letta/channels/discord/accounts.json\n",
      );
    }

    const now = new Date().toISOString();
    const account: DiscordChannelAccount = {
      channel: "discord",
      accountId: randomUUID(),
      enabled: true,
      token,
      agentId,
      defaultPermissionMode: "standard",
      dmPolicy: policy,
      allowedUsers,
      allowedChannels,
      autoThreadOnMention,
      inboundDebounceMs,
      acknowledgeMessageReaction,
      transcribeVoice,
      createdAt: now,
      updatedAt: now,
    };

    upsertChannelAccount("discord", account);
    console.log("\n✓ Discord bot configured!");
    console.log("Config written to: ~/.letta/channels/discord/accounts.json\n");
    console.log("Next steps:");
    console.log("  1. Start the listener: letta server --channels discord");
    if (channelMode === "open") {
      console.log(
        "  2. Send a message in one of the configured open Discord channels\n",
      );
    } else {
      console.log(
        "  2. DM the bot or @mention it in a Discord server to start chatting\n",
      );
    }

    return true;
  } finally {
    rl.close();
  }
}
