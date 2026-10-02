/**
 * Feishu / Lark bot setup wizard for `letta channels configure feishu`.
 *
 * Persistent connection (WebSocket) is self-built apps only. Store apps and
 * webhook-only apps are out of v1.
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { upsertChannelAccountWithSecrets } from "@/channels/accounts";
import type {
  DmPolicy,
  FeishuChannelAccount,
  FeishuDomain,
  FeishuGroupMode,
} from "@/channels/types";
import { ensureFeishuRuntimeInstalled } from "./runtime";

export async function runFeishuSetup(): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("\n🪶 Feishu / Lark Bot Setup\n");
    console.log("Create a self-built app on the Open Platform. Store apps");
    console.log("cannot use persistent connection (WebSocket).\n");
    console.log("Required steps in the developer console:");
    console.log("  1. Enable bot capability");
    console.log("  2. Subscribe to event im.message.receive_v1");
    console.log(
      "  3. Choose persistent connection (long connection), not a webhook URL",
    );
    console.log("  4. Grant scopes:");
    console.log("       im:message.p2p_msg:readonly");
    console.log("       im:message.group_at_msg:readonly");
    console.log("       im:message:send_as_bot");
    console.log("  5. Publish a version and add the bot to any groups\n");
    console.log("Only one running listener can use a given App ID. If Desktop");
    console.log("and `letta server` both connect, Feishu delivers each event");
    console.log("to one of them at random.\n");
    console.log("Pairing and allowlists use Feishu open_id values (ou_...).\n");

    await ensureFeishuRuntimeInstalled();

    const appId = (await rl.question("Enter your App ID (cli_...): ")).trim();
    if (!appId) {
      console.error("No App ID provided. Setup cancelled.");
      return false;
    }

    const appSecret = (await rl.question("Enter your App Secret: ")).trim();
    if (!appSecret) {
      console.error("No App Secret provided. Setup cancelled.");
      return false;
    }

    console.log(
      "\nPlatform — which Open Platform did you create the app on?\n",
    );
    console.log("  feishu — China (open.feishu.cn)  [default]");
    console.log("  lark   — International (open.larksuite.com)\n");
    const domainInput = await rl.question("Domain [feishu]: ");
    const domain = (domainInput.trim() || "feishu") as FeishuDomain;
    if (domain !== "feishu" && domain !== "lark") {
      console.error(`Invalid domain "${domain}". Setup cancelled.`);
      return false;
    }

    console.log("\nDM Policy — who can message this bot directly?\n");
    console.log("  pairing   — Users must pair with a code (recommended)");
    console.log("  allowlist — Only pre-approved open_id values");
    console.log("  open      — Anyone can message\n");
    const policyInput = await rl.question("DM policy [pairing]: ");
    const policy = (policyInput.trim() || "pairing") as DmPolicy;
    if (!["pairing", "allowlist", "open"].includes(policy)) {
      console.error(`Invalid policy "${policy}". Setup cancelled.`);
      return false;
    }

    let allowedUsers: string[] = [];
    if (policy === "allowlist") {
      const usersInput = await rl.question(
        "Enter allowed Feishu open_id values (comma-separated, ou_...): ",
      );
      allowedUsers = usersInput
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    }

    console.log("\nGroup behavior — when should the bot respond in groups?\n");
    console.log(
      "  mention-only — Respond only when @mentioned (recommended, matches default scopes)",
    );
    console.log(
      "  open         — Respond to every group message (needs extra event scope)\n",
    );
    const groupModeInput = await rl.question("Group mode [mention-only]: ");
    const groupMode = (groupModeInput.trim() ||
      "mention-only") as FeishuGroupMode;
    if (groupMode !== "open" && groupMode !== "mention-only") {
      console.error(`Invalid group mode "${groupMode}". Setup cancelled.`);
      return false;
    }

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
        "\nAgent ID to bind this bot to (required for group @mentions and non-pairing DMs): ",
      );
      agentId = agentInput.trim() || null;
    }
    if (!agentId) {
      console.log(
        "\nWarning: No agent bound. DM pairing will still work, but group @mentions won't route until you bind an agent.",
      );
      console.log(
        "  You can bind later: letta channels bind --channel feishu --agent <id>\n",
      );
    }

    const now = new Date().toISOString();
    const account: FeishuChannelAccount = {
      channel: "feishu",
      accountId: randomUUID(),
      enabled: true,
      appId,
      appSecret,
      domain,
      groupMode,
      agentId,
      dmPolicy: policy,
      allowedUsers,
      createdAt: now,
      updatedAt: now,
    };

    await upsertChannelAccountWithSecrets("feishu", account);
    console.log("\n✓ Feishu / Lark bot configured!");
    console.log("Config written to: ~/.letta/channels/feishu/accounts.json\n");
    console.log("Next steps:");
    console.log("  1. Start the listener: letta server --channels feishu");
    console.log(
      "  2. DM the bot (pairing) or @mention it in a group to start chatting\n",
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
