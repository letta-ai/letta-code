import { getSubagents } from "@/agent/subagent-state";
import {
  listCloudSubagents,
  usesCloudSubagents,
} from "@/backend/api/subagents";
import { getRuntimeActingUserAttribution } from "@/runtime-context";
import { resolveNotificationScope } from "@/utils/task-notifications";
import { persistedSubagentStatus } from "./subagent-persistence";

export async function list_agents() {
  const scope = resolveNotificationScope();
  if (!scope) throw new Error("ListAgents requires a calling conversation.");
  if (usesCloudSubagents()) {
    if (scope.conversationId === "default") return { agents: [] };
    const rows = await listCloudSubagents(
      scope.conversationId,
      getRuntimeActingUserAttribution(),
    );
    return {
      agents: rows.map(
        ({
          subagent_id,
          description,
          harness,
          subagent_type,
          status,
          agent_id,
          conversation_id,
          worker_session_id,
        }) => ({
          subagent_id,
          description,
          harness,
          subagent_type,
          status,
          agent_id: worker_session_id ?? agent_id,
          conversation_id,
          worker_session_id,
        }),
      ),
    };
  }

  return {
    agents: getSubagents()
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
      })),
  };
}
