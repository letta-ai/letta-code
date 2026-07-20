import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { type AgentBackendMode, isLocalAgentId } from "@/agent/agent-id";
import {
  getAgentTags,
  getCurrentCloudFavoriteTag,
  LOCAL_DESKTOP_FAVORITE_TAG,
} from "@/agent/favorites";
import { getBackendForMode } from "@/backend/backend";
import { settingsManager } from "@/settings-manager";
import { listLocalAgentsFromDisk } from "./local-agent-listing";

export interface PinnedAgentData {
  agentId: string;
  agent: AgentState | null;
  error: string | null;
  backendMode: AgentBackendMode;
}

const PINNED_AGENT_LIMIT = 100;

export function getPinnedAgentBackendMode(agentId: string): AgentBackendMode {
  return isLocalAgentId(agentId) ? "local" : "api";
}

export function hasCloudCredentials(): boolean {
  if (process.env.LETTA_API_KEY) return true;
  const settings = settingsManager.getSettings();
  const cached = settingsManager.getCachedSecureTokens();
  return Boolean(
    cached.apiKey ||
      cached.refreshToken ||
      settings.refreshToken ||
      settings.env?.LETTA_API_KEY,
  );
}

async function listCloudFavoriteAgents(): Promise<AgentState[]> {
  if (!hasCloudCredentials()) return [];
  try {
    const favoriteTag = await getCurrentCloudFavoriteTag();
    if (!favoriteTag) return [];
    const page = await getBackendForMode("api").listAgents({
      limit: PINNED_AGENT_LIMIT,
      include: ["agent.blocks"],
      order: "desc",
      order_by: "last_run_completion",
      tags: [favoriteTag],
    } as never);
    return Array.isArray(page)
      ? page
      : ((page as { items?: AgentState[] }).items ?? []);
  } catch {
    return [];
  }
}

async function retrieveLegacyPin(
  agentId: string,
  backendMode: AgentBackendMode,
): Promise<PinnedAgentData> {
  if (backendMode === "api" && !hasCloudCredentials()) {
    return { agentId, agent: null, error: "Not signed in", backendMode };
  }
  try {
    const agent = await getBackendForMode(backendMode).retrieveAgent(agentId, {
      include: ["agent.blocks"],
    });
    return { agentId, agent, error: null, backendMode };
  } catch {
    return { agentId, agent: null, error: "Agent not found", backendMode };
  }
}

export async function listPinnedAgentsForCurrentUser(
  backendModes: AgentBackendMode[] = ["api", "local"],
): Promise<PinnedAgentData[]> {
  const modes = new Set(backendModes);
  const legacyPins = [...modes].flatMap((backendMode) =>
    settingsManager
      .getPinnedAgentsForBackendMode(backendMode)
      .map((agentId) => ({ agentId, backendMode })),
  );
  const seen = new Set(
    legacyPins.map(({ agentId, backendMode }) => `${backendMode}:${agentId}`),
  );
  const legacyData = await Promise.all(
    legacyPins.map(({ agentId, backendMode }) =>
      retrieveLegacyPin(agentId, backendMode),
    ),
  );

  const favoriteAgents: Array<{
    agent: AgentState;
    backendMode: AgentBackendMode;
  }> = [];
  if (modes.has("local")) {
    favoriteAgents.push(
      ...listLocalAgentsFromDisk()
        .filter((agent) =>
          getAgentTags(agent).includes(LOCAL_DESKTOP_FAVORITE_TAG),
        )
        .map((agent) => ({ agent, backendMode: "local" as const })),
    );
  }
  if (modes.has("api")) {
    favoriteAgents.push(
      ...(await listCloudFavoriteAgents()).map((agent) => ({
        agent,
        backendMode: "api" as const,
      })),
    );
  }

  const favoriteData = favoriteAgents.flatMap(({ agent, backendMode }) => {
    const key = `${backendMode}:${agent.id}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ agentId: agent.id, agent, error: null, backendMode }];
  });
  return [...legacyData, ...favoriteData];
}
