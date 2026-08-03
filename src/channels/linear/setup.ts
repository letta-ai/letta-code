import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { upsertChannelAccountWithSecrets } from "@/channels/accounts";
import type { CustomChannelAccount } from "@/channels/types";
import { createLinearClient } from "./client";
import { displayLinearPerson } from "./notification";

const DEFAULT_POLL_INTERVAL_MS = 5000;
const MIN_POLL_INTERVAL_MS = 1000;
const MAX_POLL_INTERVAL_MS = 60_000;

function parsePollInterval(value: string): number | null {
  const parsed = Number(value.trim() || DEFAULT_POLL_INTERVAL_MS);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_POLL_INTERVAL_MS ||
    parsed > MAX_POLL_INTERVAL_MS
  ) {
    return null;
  }
  return parsed;
}

export async function runLinearSetup(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("\nLinear Channel Setup\n");
    console.log(
      "Create a personal API key for the Linear account that should receive issue notifications and post agent comments.",
    );
    console.log("Linear: Settings > Security & access > Personal API keys.\n");

    const apiKey = (await rl.question("Linear personal API key: ")).trim();
    if (!apiKey) {
      console.error("No API key provided. Setup cancelled.");
      return false;
    }

    console.log("\nValidating Linear account...");
    const viewer = await createLinearClient(apiKey).getViewer();
    console.log(
      `Connected as ${displayLinearPerson(viewer)} in ${viewer.organization?.name ?? "the configured workspace"}.`,
    );

    const envAgentId = process.env.LETTA_AGENT_ID || process.env.AGENT_ID || "";
    let agentId = "";
    if (envAgentId) {
      const useEnv = await rl.question(`Bind to agent ${envAgentId}? [Y/n]: `);
      if (!/^(n|no)$/i.test(useEnv.trim())) agentId = envAgentId;
    }
    if (!agentId) {
      agentId = (
        await rl.question("Letta agent ID for issue conversations: ")
      ).trim();
    }
    if (!agentId) {
      console.error("An agent ID is required. Setup cancelled.");
      return false;
    }

    const pollIntervalMs = parsePollInterval(
      await rl.question(
        `Poll interval in milliseconds [${DEFAULT_POLL_INTERVAL_MS}]: `,
      ),
    );
    if (pollIntervalMs === null) {
      console.error(
        `Poll interval must be an integer from ${MIN_POLL_INTERVAL_MS} to ${MAX_POLL_INTERVAL_MS}.`,
      );
      return false;
    }

    const replyInput = await rl.question(
      "Allow the agent to post Linear comments? [Y/n]: ",
    );
    const replyEnabled = !/^(n|no)$/i.test(replyInput.trim());
    const now = new Date().toISOString();
    const account: CustomChannelAccount = {
      channel: "linear",
      accountId: randomUUID(),
      displayName: `${displayLinearPerson(viewer)}${viewer.organization?.name ? ` (${viewer.organization.name})` : ""}`,
      enabled: true,
      dmPolicy: "open",
      groupPolicy: "open",
      allowedUsers: [],
      config: {
        auth: apiKey,
        agent_id: agentId,
        poll_interval_ms: pollIntervalMs,
        reply_enabled: replyEnabled,
      },
      createdAt: now,
      updatedAt: now,
    };

    await upsertChannelAccountWithSecrets("linear", account);
    console.log("\nLinear channel configured.");
    console.log("Next step:");
    console.log("  letta server --channels linear\n");
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
