import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { upsertChannelAccount } from "../accounts";
import type {
  DmPolicy,
  WhatsAppChannelAccount,
  WhatsAppGroupMode,
} from "../types";
import { ensureWhatsAppRuntimeInstalled } from "./runtime";

function isDmPolicy(value: string): value is DmPolicy {
  return value === "pairing" || value === "allowlist" || value === "open";
}

function isGroupMode(value: string): value is WhatsAppGroupMode {
  return value === "disabled" || value === "mention" || value === "open";
}

function parseCsv(input: string): string[] {
  return input
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function runWhatsAppSetup(): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("\nWhatsApp Setup\n");
    console.log(
      "WhatsApp sends as your linked WhatsApp number unless self-chat only is enabled.",
    );
    console.log(
      "Use self-chat only when you do not want the agent to send messages as you. In this mode, you talk to the agent by messaging yourself.",
    );
    console.log(
      "If this is a dedicated WhatsApp number for the agent, disable self-chat only.",
    );
    console.log(
      "Scan the QR after starting the listener: WhatsApp → Settings → Linked Devices → Link a Device.\n",
    );

    await ensureWhatsAppRuntimeInstalled();

    const selfChatInput = await rl.question("Self-chat only? [Y/n]: ");
    const selfChatMode = !/^n(o)?$/i.test(selfChatInput.trim());

    if (!selfChatMode) {
      const confirm = await rl.question(
        "Replies will appear as your WhatsApp number. Type 'I understand' to continue: ",
      );
      if (confirm.trim() !== "I understand") {
        console.error("Setup cancelled.");
        return false;
      }
    }

    console.log("\nDM policy:\n");
    console.log("  pairing   — Users must pair with a code (recommended)");
    console.log("  allowlist — Only listed phone numbers/JIDs");
    console.log("  open      — Any direct chat can route\n");
    const policyInput = await rl.question("DM policy [pairing]: ");
    const policy = policyInput.trim() || "pairing";
    if (!isDmPolicy(policy)) {
      console.error(`Invalid policy "${policy}". Setup cancelled.`);
      return false;
    }

    let allowedUsers: string[] = [];
    if (policy === "allowlist") {
      allowedUsers = parseCsv(
        await rl.question(
          "Allowed WhatsApp phone numbers/JIDs (comma-separated): ",
        ),
      );
    }

    const envAgentId = process.env.LETTA_AGENT_ID || process.env.AGENT_ID || "";
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
        "\nAgent ID for account-bound routing (optional): ",
      );
      agentId = agentInput.trim() || null;
    }

    const groupInput = await rl.question(
      "\nGroup mode: disabled, mention, or open [disabled]: ",
    );
    const groupMode = groupInput.trim() || "disabled";
    if (!isGroupMode(groupMode)) {
      console.error(`Invalid group mode "${groupMode}". Setup cancelled.`);
      return false;
    }

    const allowedGroups =
      groupMode === "disabled"
        ? []
        : parseCsv(
            await rl.question(
              "Allowed group JIDs (comma-separated, blank for all groups): ",
            ),
          );
    const mentionPatterns =
      groupMode === "mention"
        ? parseCsv(
            await rl.question(
              "Mention text aliases/regexes (comma-separated, optional): ",
            ),
          )
        : [];

    const mediaInput = await rl.question("Download inbound media? [y/N]: ");
    const downloadMedia = /^(y|yes)$/i.test(mediaInput.trim());
    const transcriptionInput = await rl.question(
      "Auto-transcribe voice memos when OPENAI_API_KEY is set? [y/N]: ",
    );
    const transcribeVoice = /^(y|yes)$/i.test(transcriptionInput.trim());

    const now = new Date().toISOString();
    const account: WhatsAppChannelAccount = {
      channel: "whatsapp",
      accountId: randomUUID(),
      enabled: true,
      dmPolicy: policy,
      allowedUsers,
      agentId,
      selfChatMode,
      groupMode,
      allowedGroups,
      mentionPatterns,
      downloadMedia,
      transcribeVoice,
      createdAt: now,
      updatedAt: now,
    };

    upsertChannelAccount("whatsapp", account);
    console.log("\nWhatsApp account configured.");
    console.log(
      "Config written to: ~/.letta/channels/whatsapp/accounts.json\n",
    );
    console.log("Next steps:");
    console.log("  1. Start the listener: letta server --channels whatsapp");
    console.log("  2. Scan the QR from WhatsApp linked devices");
    console.log(
      "  3. Message yourself in WhatsApp to pair or route the chat\n",
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
