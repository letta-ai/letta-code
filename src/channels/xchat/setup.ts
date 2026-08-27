import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import {
  listChannelAccountsWithSecrets,
  upsertChannelAccountWithSecrets,
} from "@/channels/accounts";
import type { CustomChannelAccount, DmPolicy } from "@/channels/types";
import {
  DEFAULT_XCHAT_BOOTSTRAP_LOOKBACK_MINUTES,
  DEFAULT_XCHAT_POLL_INTERVAL_MS,
} from "./account";
import {
  ensureXChatRuntimeInstalled,
  loadXChatSdkModule,
  type XChatSdkLoggerLike,
} from "./runtime";

function readEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

const SETUP_LOGGER: XChatSdkLoggerLike = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return SETUP_LOGGER;
  },
};

export async function validateXChatCredentials(
  botToken: string,
  pin: string,
): Promise<{ userId?: string; username: string }> {
  const sdk = await loadXChatSdkModule();
  const adapter = sdk.createXchatAdapter({
    botToken,
    pin,
    verifySignatures: true,
    sendReadReceipts: false,
    logger: SETUP_LOGGER,
  });
  try {
    await adapter.initialize({
      getLogger: () => SETUP_LOGGER,
      getUserName: () => adapter.userName,
      handleIncomingMessage: async () => {},
      processReaction: async () => {},
    });
    if (adapter.cryptoStatus !== "ready") {
      throw new Error(
        `X Chat encryption is ${adapter.cryptoStatus}; check the configured PIN.`,
      );
    }
    return { userId: adapter.botUserId, username: adapter.userName };
  } finally {
    await adapter.disconnect?.();
  }
}

export async function runXChatSetup(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("\nX Chat bot setup\n");
    console.log(
      "You need an X Chat bot token and the PIN used to register its encryption keys.",
    );
    await ensureXChatRuntimeInstalled();

    const envToken = readEnv("XCHAT_BOT_TOKEN");
    const token =
      envToken || (await rl.question("Enter the X Chat bot token: ")).trim();
    if (!token) {
      console.error("No bot token provided. Setup cancelled.");
      return false;
    }
    const envPin = readEnv("XCHAT_PIN");
    const pin =
      envPin || (await rl.question("Enter the X Chat encryption PIN: ")).trim();
    if (!pin) {
      console.error("No encryption PIN provided. Setup cancelled.");
      return false;
    }
    const envActivityToken = readEnv("X_BEARER_TOKEN");
    const peerUserIds = readEnv("XCHAT_PEER_USER_IDS")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const activityTokenInput =
      envActivityToken ||
      (
        await rl.question(
          "Enter the app-only Bearer token for Message requests (optional): ",
        )
      ).trim();

    console.log("\nValidating bot identity and encryption PIN...");
    const identity = await validateXChatCredentials(token, pin);
    const userId = identity.userId?.trim();
    if (!userId) {
      console.error("The X API did not return a bot user ID.");
      return false;
    }

    const policyInput = (
      await rl.question("DM policy (pairing, allowlist, open) [pairing]: ")
    ).trim();
    const dmPolicy = (policyInput || "pairing") as DmPolicy;
    if (!["pairing", "allowlist", "open"].includes(dmPolicy)) {
      console.error(`Invalid DM policy "${dmPolicy}". Setup cancelled.`);
      return false;
    }

    let allowedUsers: string[] = [];
    if (dmPolicy === "allowlist") {
      const raw = await rl.question(
        "Enter allowed X user IDs (comma-separated): ",
      );
      allowedUsers = raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }

    const now = new Date().toISOString();
    const username = identity.username.trim();
    const displayName = username ? `@${username}` : "X Chat";
    const existingAccount = (
      await listChannelAccountsWithSecrets("xchat")
    ).find(
      (candidate) =>
        candidate.channel === "xchat" &&
        (candidate.displayName === displayName ||
          candidate.config.bot_token === token),
    ) as CustomChannelAccount | undefined;
    const storedActivityToken = existingAccount?.config.activity_token;
    const activityToken =
      activityTokenInput ||
      (typeof storedActivityToken === "string" ? storedActivityToken : "");
    const storedPeerUserIds = existingAccount?.config.peer_user_ids;
    const configuredPeerUserIds =
      peerUserIds.length > 0
        ? peerUserIds
        : Array.isArray(storedPeerUserIds)
          ? storedPeerUserIds.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
    const account: CustomChannelAccount = {
      channel: "xchat",
      accountId: existingAccount?.accountId ?? randomUUID(),
      displayName,
      enabled: true,
      dmPolicy,
      allowedUsers,
      config: {
        bot_token: token,
        pin,
        ...(activityToken ? { activity_token: activityToken } : {}),
        ...(configuredPeerUserIds.length > 0
          ? { peer_user_ids: configuredPeerUserIds }
          : {}),
        poll_interval_ms: DEFAULT_XCHAT_POLL_INTERVAL_MS,
        bootstrap_lookback_minutes: DEFAULT_XCHAT_BOOTSTRAP_LOOKBACK_MINUTES,
      },
      createdAt: existingAccount?.createdAt ?? now,
      updatedAt: now,
    };
    await upsertChannelAccountWithSecrets("xchat", account);

    console.log(`\nX Chat configured for ${account.displayName}.`);
    console.log("Start the listener with: letta server --channels xchat");
    console.log(
      "Send the bot a message, then pair the chat with the code it returns.",
    );
    return true;
  } catch (error) {
    console.error(
      `X Chat setup failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return false;
  } finally {
    rl.close();
  }
}
