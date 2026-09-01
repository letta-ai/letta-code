import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import {
  listChannelAccountsWithSecrets,
  upsertChannelAccountWithSecrets,
} from "@/channels/accounts";
import type { CustomChannelAccount, DmPolicy } from "@/channels/types";
import {
  DEFAULT_XCHAT_BOOTSTRAP_LOOKBACK_MINUTES,
  DEFAULT_XCHAT_MEDIA_MAX_BYTES,
  DEFAULT_XCHAT_POLL_INTERVAL_MS,
} from "./account";
import { patchXChatPublicKeyVersionSelection } from "./public-key-version-compat";
import {
  completeXChatRegistrationCheckpoint,
  provisionXChatIdentity,
} from "./registration";
import {
  ensureXChatRuntimeInstalled,
  loadXChatSdkModule,
  loadXChatXdkModule,
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
  signingKeyVersion = "",
): Promise<{ userId?: string; username: string }> {
  const sdk = await loadXChatSdkModule();
  const adapter = sdk.createXchatAdapter({
    botToken,
    pin,
    ...(signingKeyVersion ? { signingKeyVersion } : {}),
    verifySignatures: true,
    sendReadReceipts: false,
    logger: SETUP_LOGGER,
  });
  const assertPublicKeyVersionPinned = patchXChatPublicKeyVersionSelection(
    adapter,
    signingKeyVersion,
  );
  try {
    await adapter.initialize({
      getLogger: () => SETUP_LOGGER,
      getUserName: () => adapter.userName,
      handleIncomingMessage: async () => {},
      processReaction: async () => {},
    });
    assertPublicKeyVersionPinned();
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

interface ValidatedXChatIdentity {
  userId?: string;
  username: string;
  signingKeyVersion: string;
}

export class XChatNoRecoverableIdentityError extends Error {
  readonly userId: string;

  constructor(userId: string, message: string, cause?: Error) {
    super(message, { cause });
    this.name = "XChatNoRecoverableIdentityError";
    this.userId = userId;
  }
}

function publicKeyVersion(row: Record<string, unknown>): string {
  return String(
    row.publicKeyVersion ?? row.public_key_version ?? row.version ?? "",
  ).trim();
}

function isJuiceboxNotRegistered(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).includes(
    "NotRegistered",
  );
}

async function listXChatPublicKeyVersions(
  botToken: string,
): Promise<{ userId: string; versions: string[] }> {
  const xdk = await loadXChatXdkModule();
  const client = new xdk.Client({ accessToken: botToken });
  const me = await client.users.getMe();
  const userId = me.data?.id?.trim();
  if (!userId) {
    throw new Error("The X API did not return a bot user ID.");
  }
  const response = await client.users.getPublicKey(userId, {
    publicKeyFields: ["public_key_version", "juicebox_config"],
  });
  const versions = [...new Set((response.data ?? []).map(publicKeyVersion))]
    .filter(Boolean)
    .sort((left, right) => Number(right) - Number(left));
  return { userId, versions };
}

/**
 * Validate the newest recoverable registered identity without writing keys.
 * Only NotRegistered advances to an older version. Invalid PINs, auth errors,
 * missing versions, and every other failure stop immediately.
 */
export async function resolveXChatCredentials(
  botToken: string,
  pin: string,
  requestedVersion = "",
  allowRequestedVersionFallback = false,
): Promise<ValidatedXChatIdentity> {
  const requested = requestedVersion.trim();
  const inventory = await listXChatPublicKeyVersions(botToken);
  if (inventory.versions.length === 0) {
    throw new XChatNoRecoverableIdentityError(
      inventory.userId,
      "This bot has no registered X Chat key versions.",
    );
  }
  const versions = requested
    ? [
        requested,
        ...(allowRequestedVersionFallback
          ? inventory.versions.filter((version) => version !== requested)
          : []),
      ]
    : inventory.versions;
  let lastNotRegistered: Error | null = null;

  for (const version of versions) {
    try {
      const identity = await validateXChatCredentials(botToken, pin, version);
      if (identity.userId && identity.userId !== inventory.userId) {
        throw new Error(
          "The X Chat key inventory and validated bot identity do not match.",
        );
      }
      return { ...identity, signingKeyVersion: version };
    } catch (error) {
      if (
        (!requested || allowRequestedVersionFallback) &&
        isJuiceboxNotRegistered(error)
      ) {
        lastNotRegistered =
          error instanceof Error ? error : new Error(String(error));
        continue;
      }
      throw error;
    }
  }

  throw new XChatNoRecoverableIdentityError(
    inventory.userId,
    "None of the registered X Chat key versions can be recovered from " +
      "Juicebox with this PIN.",
    lastNotRegistered ?? undefined,
  );
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
    const peerUserIds = readEnv("XCHAT_PEER_USER_IDS")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    const existingAccounts = await listChannelAccountsWithSecrets("xchat");
    const existingAccountByToken = existingAccounts.find(
      (candidate) =>
        candidate.channel === "xchat" && candidate.config.bot_token === token,
    ) as CustomChannelAccount | undefined;
    const envSigningKeyVersion = readEnv("XCHAT_SIGNING_KEY_VERSION");
    const storedSigningKeyVersion =
      existingAccountByToken?.config.signing_key_version;
    const requestedSigningKeyVersion =
      envSigningKeyVersion ||
      (typeof storedSigningKeyVersion === "string"
        ? storedSigningKeyVersion
        : "");

    console.log("\nValidating bot identity and encryption PIN...");
    let identity: ValidatedXChatIdentity;
    try {
      identity = await resolveXChatCredentials(
        token,
        pin,
        requestedSigningKeyVersion,
        !envSigningKeyVersion && Boolean(storedSigningKeyVersion),
      );
    } catch (error) {
      if (
        !(error instanceof XChatNoRecoverableIdentityError) ||
        envSigningKeyVersion
      ) {
        throw error;
      }
      console.log(`\n${error.message}`);
      console.log(
        "Letta Code can create one identity safely: it checkpoints private keys before the rate-limited X write, resumes the same key after interruption, stores it in Juicebox, and verifies a fresh recovery.",
      );
      const confirmation = (
        await rl.question(
          "Type REGISTER to create and publish one X Chat identity, or press Enter to cancel: ",
        )
      ).trim();
      if (confirmation !== "REGISTER") {
        console.error("X Chat registration cancelled; no key was written.");
        return false;
      }
      const provisioned = await provisionXChatIdentity(token, pin, {
        status: (message) => console.log(`  ${message}`),
      });
      const validated = await validateXChatCredentials(
        token,
        pin,
        provisioned.signingKeyVersion,
      );
      if (validated.userId && validated.userId !== provisioned.userId) {
        throw new Error(
          "The provisioned X Chat identity and validated bot user do not match.",
        );
      }
      identity = {
        ...validated,
        userId: validated.userId ?? provisioned.userId,
        signingKeyVersion: provisioned.signingKeyVersion,
      };
    }
    const userId = identity.userId?.trim();
    if (!userId) {
      console.error("The X API did not return a bot user ID.");
      return false;
    }

    const username = identity.username.trim();
    const displayName = username ? `@${username}` : "X Chat";
    const existingAccount = existingAccounts.find(
      (candidate) =>
        candidate.channel === "xchat" &&
        (candidate.displayName === displayName ||
          candidate.config.bot_token === token),
    ) as CustomChannelAccount | undefined;
    const envActivityToken = readEnv("X_BEARER_TOKEN");
    const activityTokenInput =
      envActivityToken ||
      (
        await rl.question(
          "Enter the app-only Bearer token for Message requests (optional): ",
        )
      ).trim();
    const existingPolicy = existingAccount?.dmPolicy ?? "pairing";
    const policyInput = (
      await rl.question(
        `DM policy (pairing, allowlist, open) [${existingPolicy}]: `,
      )
    ).trim();
    const dmPolicy = (policyInput || existingPolicy) as DmPolicy;
    if (!["pairing", "allowlist", "open"].includes(dmPolicy)) {
      console.error(`Invalid DM policy "${dmPolicy}". Setup cancelled.`);
      return false;
    }

    let allowedUsers = [...(existingAccount?.allowedUsers ?? [])];
    if (dmPolicy === "allowlist") {
      const raw = await rl.question(
        `Enter allowed X user IDs (comma-separated)${allowedUsers.length > 0 ? ` [${allowedUsers.join(",")}]` : ""}: `,
      );
      if (raw.trim()) {
        allowedUsers = raw
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
      }
    }
    const existingTranscribeVoice =
      existingAccount?.config.transcribe_voice === true;
    const transcriptionInput = await rl.question(
      `Transcribe voice messages when OPENAI_API_KEY is set? [${existingTranscribeVoice ? "Y/n" : "y/N"}]: `,
    );
    const transcriptionAnswer = transcriptionInput.trim();
    const transcribeVoice = transcriptionAnswer
      ? /^(y|yes)$/i.test(transcriptionAnswer)
      : existingTranscribeVoice;

    const now = new Date().toISOString();
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
        signing_key_version: identity.signingKeyVersion,
        ...(activityToken ? { activity_token: activityToken } : {}),
        ...(configuredPeerUserIds.length > 0
          ? { peer_user_ids: configuredPeerUserIds }
          : {}),
        poll_interval_ms:
          typeof existingAccount?.config.poll_interval_ms === "number"
            ? existingAccount.config.poll_interval_ms
            : DEFAULT_XCHAT_POLL_INTERVAL_MS,
        bootstrap_lookback_minutes:
          typeof existingAccount?.config.bootstrap_lookback_minutes === "number"
            ? existingAccount.config.bootstrap_lookback_minutes
            : DEFAULT_XCHAT_BOOTSTRAP_LOOKBACK_MINUTES,
        download_media:
          typeof existingAccount?.config.download_media === "boolean"
            ? existingAccount.config.download_media
            : true,
        media_max_bytes:
          typeof existingAccount?.config.media_max_bytes === "number"
            ? existingAccount.config.media_max_bytes
            : DEFAULT_XCHAT_MEDIA_MAX_BYTES,
        transcribe_voice: transcribeVoice,
      },
      createdAt: existingAccount?.createdAt ?? now,
      updatedAt: now,
    };
    await upsertChannelAccountWithSecrets("xchat", account);
    completeXChatRegistrationCheckpoint(userId, identity.signingKeyVersion);

    console.log(
      `\nX Chat configured for ${account.displayName} with key version ${identity.signingKeyVersion}.`,
    );
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
