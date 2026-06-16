import { createInterface } from "node:readline/promises";
import { upsertChannelAccount } from "@/channels/accounts";
import type {
  DmPolicy,
  SignalChannelAccount,
  SignalGroupMode,
} from "@/channels/types";
import { SignalRestClient } from "./client";

const DEFAULT_SIGNAL_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_SIGNAL_ACCOUNT_ID = "personal";
const DEFAULT_SIGNAL_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

function parseYesNo(input: string, defaultValue: boolean): boolean {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return defaultValue;
  return /^(y|yes|true|1)$/i.test(trimmed);
}

export function parseSignalCsv(input: string): string[] {
  return input
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function normalizeSignalPhoneInput(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.startsWith("+")
    ? `+${trimmed.slice(1).replace(/\D/g, "")}`
    : `+${trimmed.replace(/\D/g, "")}`;
  return /^\+\d{5,15}$/.test(normalized) ? normalized : undefined;
}

export function normalizeSignalBaseUrl(input: string): string | undefined {
  const trimmed = input.trim() || DEFAULT_SIGNAL_BASE_URL;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function isDmPolicy(value: string): value is DmPolicy {
  return value === "pairing" || value === "allowlist" || value === "open";
}

function isSignalGroupMode(value: string): value is SignalGroupMode {
  return value === "disabled" || value === "mention" || value === "open";
}

function parseMediaMaxBytes(input: string): number | undefined {
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_SIGNAL_MEDIA_MAX_BYTES;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

export async function runSignalSetup(): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("\n📱 Signal Setup\n");
    console.log(
      "Letta talks to Signal through signal-cli-rest-api in JSON-RPC/SSE mode.",
    );
    console.log(
      "Recommended: use a dedicated Signal number for the agent. If you use your personal Signal account, self-message loop protection may ignore your own messages.",
    );
    console.log(
      "Before continuing, start signal-cli-rest-api with MODE=json-rpc and register/link the Signal account. See src/channels/signal/README.md for examples.\n",
    );

    const accountIdInput = await rl.question(
      `Account id [${DEFAULT_SIGNAL_ACCOUNT_ID}]: `,
    );
    const accountId = accountIdInput.trim() || DEFAULT_SIGNAL_ACCOUNT_ID;

    const baseUrlInput = await rl.question(
      `signal-cli-rest-api base URL [${DEFAULT_SIGNAL_BASE_URL}]: `,
    );
    const baseUrl = normalizeSignalBaseUrl(baseUrlInput);
    if (!baseUrl) {
      console.error("Invalid base URL. Setup cancelled.");
      return false;
    }

    const probeInput = await rl.question("Probe daemon now? [Y/n]: ");
    if (parseYesNo(probeInput, true)) {
      try {
        await new SignalRestClient({ baseUrl }).check();
        console.log("✓ signal-cli-rest-api responded.\n");
      } catch (error) {
        console.error(
          `Could not reach signal-cli-rest-api at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
        );
        console.error(
          "Start the daemon with MODE=json-rpc or choose not to probe if it runs elsewhere.",
        );
        return false;
      }
    }

    const accountInput = await rl.question(
      "Signal account phone number in E.164 format (e.g. +15555550100): ",
    );
    const account = normalizeSignalPhoneInput(accountInput);
    if (!account) {
      console.error("Invalid Signal phone number. Setup cancelled.");
      return false;
    }

    const accountUuidInput = await rl.question(
      "Signal account UUID for self-message filtering (optional): ",
    );
    const accountUuid = accountUuidInput.trim() || undefined;

    console.log("\nDM policy — who can message this Signal account?\n");
    console.log("  pairing   — Users must pair with a code (recommended)");
    console.log("  allowlist — Only listed phone numbers/UUIDs");
    console.log("  open      — Any direct chat can route\n");
    const policyInput = await rl.question("DM policy [pairing]: ");
    const dmPolicy = policyInput.trim() || "pairing";
    if (!isDmPolicy(dmPolicy)) {
      console.error(`Invalid DM policy "${dmPolicy}". Setup cancelled.`);
      return false;
    }

    let allowedUsers: string[] = [];
    if (dmPolicy === "allowlist") {
      allowedUsers = parseSignalCsv(
        await rl.question(
          "Allowed Signal phone numbers/UUIDs (comma-separated): ",
        ),
      );
    }

    const envAgentId = process.env.LETTA_AGENT_ID || process.env.AGENT_ID || "";
    let agentId: string | null = null;
    if (envAgentId) {
      const useEnv = await rl.question(
        `\nBind to agent ${envAgentId}? [Y/n]: `,
      );
      if (parseYesNo(useEnv, true)) {
        agentId = envAgentId;
      }
    }
    if (!agentId) {
      const agentInput = await rl.question(
        "\nAgent ID for account-bound DM/group routing (optional): ",
      );
      agentId = agentInput.trim() || null;
    }

    const groupInput = await rl.question(
      "\nGroup mode: disabled, mention, or open [disabled]: ",
    );
    const groupMode = groupInput.trim() || "disabled";
    if (!isSignalGroupMode(groupMode)) {
      console.error(`Invalid group mode "${groupMode}". Setup cancelled.`);
      return false;
    }

    const allowedGroups =
      groupMode === "disabled"
        ? []
        : parseSignalCsv(
            await rl.question(
              "Allowed Signal group IDs (comma-separated, blank for all groups): ",
            ),
          );
    const mentionPatterns =
      groupMode === "mention"
        ? parseSignalCsv(
            await rl.question(
              "Mention text aliases/regexes (comma-separated, default: letta): ",
            ),
          )
        : [];

    const mediaInput = await rl.question("Download inbound media? [Y/n]: ");
    const downloadMedia = parseYesNo(mediaInput, true);
    const mediaMaxInput = await rl.question(
      `Maximum inbound media bytes [${DEFAULT_SIGNAL_MEDIA_MAX_BYTES}]: `,
    );
    const mediaMaxBytes = parseMediaMaxBytes(mediaMaxInput);
    if (!mediaMaxBytes) {
      console.error("Invalid media byte limit. Setup cancelled.");
      return false;
    }

    console.log(
      "\nVoice transcription requires OPENAI_API_KEY. Some Signal voice notes arrive as raw .aac and require ffmpeg on the listener machine.",
    );
    const transcriptionInput = await rl.question(
      "Auto-transcribe Signal audio when OPENAI_API_KEY is set? [y/N]: ",
    );
    const transcribeVoice = parseYesNo(transcriptionInput, false);

    const now = new Date().toISOString();
    const accountRecord: SignalChannelAccount = {
      channel: "signal",
      accountId,
      displayName: `Signal ${account}`,
      enabled: true,
      baseUrl,
      account,
      accountUuid,
      agentId,
      dmPolicy,
      allowedUsers,
      groupMode,
      allowedGroups,
      mentionPatterns:
        groupMode === "mention" && mentionPatterns.length === 0
          ? ["letta"]
          : mentionPatterns,
      downloadMedia,
      mediaMaxBytes,
      transcribeVoice,
      createdAt: now,
      updatedAt: now,
    };

    upsertChannelAccount("signal", accountRecord);
    console.log("\n✓ Signal account configured!");
    console.log("Config written to: ~/.letta/channels/signal/accounts.json\n");
    console.log("Next steps:");
    console.log("  1. Start/restart: letta server --channels signal");
    console.log("  2. Send the Signal account a DM to receive a pairing code");
    console.log(
      "  3. In the target ADE/Desktop conversation, run: /channels signal pair <code>",
    );
    console.log(
      "  4. If voice transcription reports ffmpeg errors, install ffmpeg on the listener machine.\n",
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
