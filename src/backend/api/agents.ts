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

/**
 * One conversation's resolved runtime status from the cloud's per-agent
 * runtime-status snapshot (the read surface of the super-run architecture).
 * Only the fields the environment-turn wait consumes are typed here.
 */
export interface AgentRuntimeStatusEntry {
  conversation_id: string;
  /**
   * IDLE: no owner, no pending inputs, no live runs.
   * PENDING_DELIVERY: an input is queued but not yet accepted by a listener.
   * ACTIVE: one listener owns the conversation; loop_state is its report.
   * ACTIVE_UNATTRIBUTED: live run(s) with no owning listener.
   */
  state: "IDLE" | "PENDING_DELIVERY" | "ACTIVE" | "ACTIVE_UNATTRIBUTED";
  /** The owning listener's loop status, relayed verbatim; null when unowned. */
  loop_state: { status: string } | null;
  active_harness?: { connection_id: string } | null;
  has_conflicting_listeners?: boolean;
  active_run_ids: string[];
  last_activity_at: number;
  /** Inputs waiting for the owning listener, e.g. a task notification. */
  queue?: unknown[];
  /** Background work the owning listener reports for this conversation. */
  active_bash_count?: number;
  active_monitor_count?: number;
  /**
   * Running Monitors, when the server lists them. Persistent Monitors never
   * end on their own. Absent on older servers; use active_monitor_count.
   */
  active_monitors?: {
    process_id: string;
    description: string;
    persistent?: boolean;
  }[];
  active_workflow_count?: number;
  has_active_background_subagents?: boolean;
}

export interface AgentRuntimeStatusSnapshot {
  agent_id: string;
  snapshot_at: number;
  statuses: AgentRuntimeStatusEntry[];
}

/**
 * GET /v1/agents/:agentId/runtime-status?conversation_ids=...
 *
 * Returns the resolved runtime status for the requested conversations;
 * unknown ids resolve to IDLE. 404 means the server does not expose the
 * route (older server or the feed kill switch is off).
 */
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
