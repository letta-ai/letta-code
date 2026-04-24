import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import {
  listChannelAccounts,
  removeChannelAccount,
  upsertChannelAccount,
} from "../accounts";
import type { BlueskyChannelAccount, DmPolicy } from "../types";
import {
  DEFAULT_APPVIEW_URL,
  DEFAULT_NOTIFICATIONS_INTERVAL_SEC,
  DEFAULT_SERVICE_URL,
  DEFAULT_THREAD_CONTEXT_DEPTH,
} from "./constants";
import { ensureBlueskyRuntimeInstalled } from "./runtime";
import { createSession } from "./session";

function isValidHandle(handle: string): boolean {
  // Handles are of the form `name.<tld>`; the domain part is required.
  return /^[a-z0-9._-]+\.[a-z0-9.-]+$/i.test(handle) && handle.includes(".");
}

export async function runBlueskySetup(): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("\nBluesky setup\n");
    console.log("You'll need a Bluesky account and an app password.");
    console.log(
      "  1. Open https://bsky.app and sign in to the account the bot should use.",
    );
    console.log(
      "  2. Settings → Privacy and security → App Passwords → Add App Password.",
    );
    console.log("  3. Copy the generated password (shown once).\n");
    console.log(
      "App passwords can post, like, follow, and read public notifications. They",
    );
    console.log(
      "cannot read or send DMs (chat.bsky.convo.*), change the account password,",
    );
    console.log("or disable the account.\n");

    await ensureBlueskyRuntimeInstalled();

    const handleInput = (
      await rl.question("Handle (e.g. loop.bsky.social): ")
    ).trim();
    const handle = handleInput.replace(/^@/, "");
    if (!isValidHandle(handle)) {
      console.error(
        `"${handleInput}" doesn't look like a valid Bluesky handle.`,
      );
      return false;
    }

    const appPassword = (await rl.question("App password: ")).trim();
    if (!appPassword) {
      console.error("App password is required.");
      return false;
    }

    const customService = (
      await rl.question(`PDS URL [${DEFAULT_SERVICE_URL}]: `)
    ).trim();
    const serviceUrl = customService || DEFAULT_SERVICE_URL;

    const customAppView = (
      await rl.question(`AppView URL [${DEFAULT_APPVIEW_URL}]: `)
    ).trim();
    const appViewUrl = customAppView || DEFAULT_APPVIEW_URL;

    console.log("\nValidating credentials with createSession...");
    let session: Awaited<ReturnType<typeof createSession>>;
    try {
      session = await createSession({ handle, appPassword, serviceUrl });
    } catch (err) {
      console.error(
        `Authentication failed: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
    console.log(
      `✓ Authenticated as @${session.handle || handle} (${session.did}).\n`,
    );

    console.log(
      "Note: Bluesky V1 only handles public notifications (mentions, replies,",
    );
    console.log(
      "quotes). Bluesky DMs (chat.bsky.convo.*) are not supported — they require",
    );
    console.log("OAuth with transition:chat.bsky scope.\n");

    console.log(
      "Inbound policy — whose public mentions/replies should reach the agent?\n",
    );
    console.log(
      "  open      — any author whose mention/reply/quote reaches the account (recommended)",
    );
    console.log("  allowlist — only the DIDs listed below\n");

    const policyInput = await rl.question("Inbound policy [open]: ");
    const policy = (policyInput.trim() || "open") as DmPolicy;
    if (!["open", "allowlist"].includes(policy)) {
      console.error(`Invalid policy "${policy}". Setup cancelled.`);
      return false;
    }

    let allowedUsers: string[] = [];
    if (policy === "allowlist") {
      const usersInput = await rl.question(
        "Enter allowed author DIDs (comma-separated, e.g. did:plc:...): ",
      );
      allowedUsers = usersInput
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (allowedUsers.length === 0) {
        console.log(
          "No DIDs entered — no one will be delivered. You can add DIDs later.",
        );
      }
    }

    const intervalInput = (
      await rl.question(
        `Poll interval in seconds [${DEFAULT_NOTIFICATIONS_INTERVAL_SEC}]: `,
      )
    ).trim();
    const intervalSec = intervalInput
      ? Math.max(
          10,
          Number.parseInt(intervalInput, 10) ||
            DEFAULT_NOTIFICATIONS_INTERVAL_SEC,
        )
      : DEFAULT_NOTIFICATIONS_INTERVAL_SEC;

    console.log(
      "\nBackfill: deliver any existing unseen mentions/replies/quotes from",
    );
    console.log(
      "the AppView the first time the listener starts? Default no — the first",
    );
    console.log(
      "poll silently advances state and only notifications that arrive AFTER",
    );
    console.log("the listener is running will be delivered.");
    const backfillInput = (await rl.question("Backfill on first poll? [y/N]: "))
      .trim()
      .toLowerCase();
    const backfill = backfillInput === "y" || backfillInput === "yes";

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
        "\nAgent ID to bind this Bluesky account to (required for auto-routing): ",
      );
      agentId = agentInput.trim() || null;
    }

    if (!agentId) {
      console.log(
        "\nWarning: no agent bound — notifications will arrive, but won't route until you bind an agent.",
      );
      console.log(
        "  Bind later: letta channels bind --channel bluesky --agent <id>\n",
      );
    }

    // Reuse the existing accountId if this handle is already configured.
    // Avoids duplicate adapter instances racing on the same state slot.
    const existing = listChannelAccounts("bluesky")
      .filter((a): a is BlueskyChannelAccount => a.channel === "bluesky")
      .find((a) => a.handle.toLowerCase() === handle.toLowerCase());
    if (existing) {
      console.log(
        `\nFound existing config for @${handle} (accountId ${existing.accountId}).`,
      );
      const overwrite = (await rl.question("Overwrite it? [Y/n]: "))
        .trim()
        .toLowerCase();
      if (overwrite === "n" || overwrite === "no") {
        console.log("Aborted. No changes made.");
        return false;
      }
      removeChannelAccount("bluesky", existing.accountId);
    }

    const now = new Date().toISOString();
    const account: BlueskyChannelAccount = {
      channel: "bluesky",
      accountId: existing?.accountId ?? randomUUID(),
      enabled: true,
      handle,
      appPassword,
      serviceUrl,
      appViewUrl,
      intervalSec,
      threadContextDepth: DEFAULT_THREAD_CONTEXT_DEPTH,
      reasons: ["mention", "reply", "quote"],
      backfill,
      agentId,
      dmPolicy: policy,
      allowedUsers,
      createdAt: now,
      updatedAt: now,
    };

    upsertChannelAccount("bluesky", account);

    console.log("\n✓ Bluesky account configured.");
    console.log("Config written to: ~/.letta/channels/bluesky/accounts.json\n");
    console.log("Next steps:");
    console.log("  1. Start the listener: letta server --channels bluesky");
    console.log(
      "  2. Mention the account from another Bluesky handle to trigger the first reply.\n",
    );

    return true;
  } finally {
    rl.close();
  }
}
