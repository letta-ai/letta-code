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

export function shouldIncludeConstellationRecentAgents(
  includeConstellation: boolean,
  settings: Pick<Settings, "refreshToken" | "env">,
): boolean {
  return Boolean(
    includeConstellation &&
      (settings.refreshToken || settings.env?.LETTA_API_KEY),
  );
}

export async function getRecentAgentOptions(options?: {
  includeLocal?: boolean;
  includeConstellation?: boolean;
  limit?: number;
  currentAgentId?: string;
}): Promise<RecentAgentOption[]> {
  const includeLocal = options?.includeLocal !== false;
  const includeConstellation = options?.includeConstellation !== false;
  const limit = options?.limit ?? 5;
  const settings = includeConstellation
    ? await settingsManager.getSettingsWithSecureTokens()
    : null;
  const shouldIncludeConstellation =
    settings !== null
      ? shouldIncludeConstellationRecentAgents(includeConstellation, settings)
      : false;

  const localAgents = includeLocal
    ? listLocalAgentsFromDisk().map((agent) => ({ agent, isLocal: true }))
    : [];

  const constellationAgents = shouldIncludeConstellation
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
    [...localAgents, ...constellationAgents].filter((item) => {
      if (seen.has(item.agent.id)) return false;
      seen.add(item.agent.id);
      return true;
    }),
    options?.currentAgentId,
  );

  return deduped.slice(0, limit);
}
