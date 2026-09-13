import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getClient } from "@/backend/api/client";
import { listLocalAgentsFromDisk } from "@/cli/helpers/local-agent-listing";
import type { Settings } from "@/settings-manager";
import { settingsManager } from "@/settings-manager";

export interface RecentAgentOption {
  agent: AgentState;
  isLocal: boolean;
}

function sortRecentAgents(
  agents: RecentAgentOption[],
  currentAgentId?: string,
): RecentAgentOption[] {
  return agents.toSorted((a, b) => {
    if (currentAgentId) {
      if (a.agent.id === currentAgentId) return -1;
      if (b.agent.id === currentAgentId) return 1;
    }

    const aTime = a.agent.last_run_completion
      ? new Date(a.agent.last_run_completion).getTime()
      : 0;
    const bTime = b.agent.last_run_completion
      ? new Date(b.agent.last_run_completion).getTime()
      : 0;
    return bTime - aTime;
  });
}

export function shouldIncludeCloudRecentAgents(
  includeCloud: boolean,
  settings: Pick<Settings, "refreshToken" | "env">,
): boolean {
  return Boolean(
    includeCloud && (settings.refreshToken || settings.env?.LETTA_API_KEY),
  );
}

export async function getRecentAgentOptions(options?: {
  includeLocal?: boolean;
  includeCloud?: boolean;
  limit?: number;
  currentAgentId?: string;
}): Promise<RecentAgentOption[]> {
  const includeLocal = options?.includeLocal !== false;
  const includeCloud = options?.includeCloud !== false;
  const limit = options?.limit ?? 5;
  const settings = includeCloud
    ? await settingsManager.getSettingsWithSecureTokens()
    : null;
  const shouldIncludeCloud =
    settings !== null
      ? shouldIncludeCloudRecentAgents(includeCloud, settings)
      : false;

  const localAgents = includeLocal
    ? listLocalAgentsFromDisk().map((agent) => ({ agent, isLocal: true }))
    : [];

  const cloudAgents = shouldIncludeCloud
    ? await (async () => {
        try {
          const client = await getClient();
          const result = await client.agents.list({
            limit,
            include: ["agent.blocks"],
            order: "desc",
            order_by: "last_run_completion",
          });
          return result.items.map((agent) => ({ agent, isLocal: false }));
        } catch {
          return [];
        }
      })()
    : [];

  const seen = new Set<string>();
  const deduped = sortRecentAgents(
    [...localAgents, ...cloudAgents].filter((item) => {
      if (seen.has(item.agent.id)) return false;
      seen.add(item.agent.id);
      return true;
    }),
    options?.currentAgentId,
  );

  return deduped.slice(0, limit);
}
