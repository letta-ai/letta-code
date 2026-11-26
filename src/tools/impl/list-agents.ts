import { getSubagents } from "@/agent/subagent-state";
import {
  listCloudSubagentsPage,
  type PersistedSubagentStatus,
  usesCloudSubagents,
} from "@/backend/api/subagents";
import { getRuntimeActingUserAttribution } from "@/runtime-context";
import ListAgentsSchema from "@/tools/schemas/ListAgents.json";
import { resolveNotificationScope } from "@/utils/task-notifications";
import { persistedSubagentStatus } from "./subagent-persistence";

function formatPage<T extends { subagent_id: string }>(
  rows: T[],
  limit: number,
) {
  const agents = rows.slice(0, limit);
  const has_more = rows.length > limit;
  return {
    agents,
    has_more,
    next_cursor: has_more ? (agents.at(-1)?.subagent_id ?? null) : null,
  };
}

export async function list_agents({
  limit = 20,
  cursor,
  status,
}: {
  limit?: number;
  cursor?: string;
  status?: Exclude<PersistedSubagentStatus, "idle">;
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("ListAgents limit must be an integer between 1 and 100.");
  }
  if (
    status !== undefined &&
    !ListAgentsSchema.properties.status.enum.includes(status)
  ) {
    throw new Error(
      "ListAgents status must be running, completed, failed, or stopped.",
    );
  }
  const scope = resolveNotificationScope();
  if (!scope) throw new Error("ListAgents requires a calling conversation.");
  if (usesCloudSubagents()) {
    if (scope.conversationId === "default") return formatPage([], limit);
    const rows = await listCloudSubagentsPage(
      scope.conversationId,
      getRuntimeActingUserAttribution(),
      { after: cursor, limit: limit + 1, status },
    );
    return formatPage(
      rows.map(
        ({
          subagent_id,
          description,
          harness,
          subagent_type,
          status,
          agent_id,
          conversation_id,
          worker_session_id,
          created_at,
          updated_at,
        }) => ({
          subagent_id,
          description,
          harness,
          subagent_type,
          status,
          agent_id: worker_session_id ?? agent_id,
          conversation_id,
          worker_session_id,
          created_at,
          updated_at,
        }),
      ),
      limit,
    );
  }

  const rows = getSubagents()
    .filter(
      (agent) =>
        agent.parentAgentId === scope.agentId &&
        agent.parentConversationId === scope.conversationId,
    )
    .map((agent) => ({
      subagent_id: agent.id,
      description: agent.description,
      subagent_type: agent.type,
      status: persistedSubagentStatus(agent),
      agent_id: agent.agentId ?? null,
      conversation_id: agent.conversationId ?? null,
      created_at: new Date(agent.startTime).toISOString(),
      updated_at: new Date(agent.updatedAt ?? agent.startTime).toISOString(),
    }))
    .sort(
      (a, b) =>
        b.updated_at.localeCompare(a.updated_at) ||
        b.subagent_id.localeCompare(a.subagent_id),
    );
  const cursorIndex = cursor
    ? rows.findIndex((row) => row.subagent_id === cursor)
    : -1;
  if (cursor && cursorIndex === -1) return formatPage([], limit);
  const page = rows
    .slice(cursorIndex + 1)
    .filter((row) => !status || row.status === status);
  return formatPage(page, limit);
}
