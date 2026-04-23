import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { upsertChannelAccount } from "../accounts";
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
      "App passwords are scoped — they can post, like, follow, and read DMs, but they",
    );
    console.log("can't change the account password or disable the account.\n");

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

    console.log("DM policy — which Bluesky authors can reach the agent?\n");
    console.log(
      "  open      — anyone whose mention/reply reaches the account (recommended)",
    );
    console.log("  allowlist — only the DIDs listed below\n");
    console.log(
      "  (pairing is not supported on Bluesky — public social doesn't map to it.)\n",
    );

    const policyInput = await rl.question("DM policy [open]: ");
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

    const now = new Date().toISOString();
    const account: BlueskyChannelAccount = {
      channel: "bluesky",
      accountId: randomUUID(),
      enabled: true,
      handle,
      appPassword,
      serviceUrl,
      appViewUrl,
      intervalSec,
      threadContextDepth: DEFAULT_THREAD_CONTEXT_DEPTH,
      reasons: ["mention", "reply", "quote"],
      backfill: false,
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
    console.log(
      "Note: app passwords can't DM or invite — only read notifications and post on behalf of the account.",
    );

    return true;
  } finally {
    rl.close();
  }
}
