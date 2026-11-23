import { apiRequest } from "./request";

export async function getAgentContextOverview<T>(
  agentId: string,
  options?: { signal?: AbortSignal },
): Promise<T> {
  return apiRequest<T>("GET", `/v1/agents/${agentId}/context`, undefined, {
    signal: options?.signal,
  });
}

export async function createMinimalAgent(
  apiKey: string,
  name: string,
): Promise<{ id: string; name: string }> {
  return apiRequest<{ id: string; name: string }>(
    "POST",
    "/v1/agents",
    { name },
    {
      baseUrl: "https://api.letta.com",
      apiKey,
    },
  );
}

export interface AgentRuntimeStatusEntry {
  conversation_id: string;
  state: "IDLE" | "PENDING_DELIVERY" | "ACTIVE" | "ACTIVE_UNATTRIBUTED";
  loop_state: { status: string } | null;
  active_bash_count?: number;
  active_harness?: { connection_id: string } | null;
  has_conflicting_listeners?: boolean;
  active_run_ids: string[];
  last_activity_at: number;
}

export interface AgentRuntimeStatusSnapshot {
  agent_id: string;
  snapshot_at: number;
  statuses: AgentRuntimeStatusEntry[];
}

export async function getAgentRuntimeStatus(
  agentId: string,
  conversationIds: string[],
  signal?: AbortSignal,
): Promise<AgentRuntimeStatusSnapshot> {
  return apiRequest<AgentRuntimeStatusSnapshot>(
    "GET",
    `/v1/agents/${encodeURIComponent(agentId)}/runtime-status`,
    undefined,
    { query: { conversation_ids: conversationIds.join(",") }, signal },
  );
}
