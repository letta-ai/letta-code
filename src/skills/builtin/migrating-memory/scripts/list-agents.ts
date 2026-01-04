#!/usr/bin/env npx ts-node
/**
 * List Agents - Lists all agents accessible to the user
 *
 * Usage:
 *   npx ts-node list-agents.ts
 *
 * Output:
 *   Raw API response from GET /v1/agents
 */

import type Letta from "@letta-ai/letta-client";
import { getClient } from "../../../../agent/client";
import { settingsManager } from "../../../../settings-manager";

/**
 * List all agents accessible to the user
 * @param client - Letta client instance
 * @returns Array of agent objects from the API
 */
export async function listAgents(
  client: Letta,
): Promise<Awaited<ReturnType<typeof client.agents.list>>> {
  return await client.agents.list();
}

// CLI entry point
if (require.main === module) {
  (async () => {
    try {
      await settingsManager.initialize();
      const client = await getClient();
      const result = await listAgents(client);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  })();
}
