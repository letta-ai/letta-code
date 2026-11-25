import type { SubagentState } from "@/agent/subagent-state";
import type { AgentSandboxOptions } from "@/backend/api/environments";
import {
  createSubagentWriter,
  type PersistedSubagentStatus,
  type SubagentLinks,
  type SubagentSpawn,
  usesCloudSubagents,
} from "@/backend/api/subagents";
import { getRuntimeActingUserAttribution } from "@/runtime-context";
import type { SubagentLaunchArgs } from "@/types/subagent-protocol";

export function createLaunchSubagentObserver(
  scope: { agentId: string; conversationId: string } | undefined,
  args: Partial<SubagentLaunchArgs>,
  description: string,
  prompt: string,
  harness: string,
  forkContext: boolean,
  computer?: string,
  cloud?: AgentSandboxOptions,
): (() => (state: SubagentState) => void) | undefined {
  if (!scope || scope.conversationId === "default" || !usesCloudSubagents())
    return;
  const actingUserId = getRuntimeActingUserAttribution();
  const input: SubagentSpawn = {
    parent_agent_id: scope.agentId,
    parent_conversation_id: scope.conversationId,
    description,
    prompt,
    harness,
    subagent_type: args.subagent_type ?? null,
    fork_context: forkContext,
    model_config: args.model ? { model: args.model } : null,
    agent_id: args.agent_id ?? null,
    conversation_id:
      args.conversation_id === "default"
        ? null
        : (args.conversation_id ?? null),
    computer: computer ?? null,
    repositories:
      cloud?.githubRepositories?.map(
        ({ owner, repo, commit }) =>
          `${owner}/${repo}${commit ? `@${commit}` : ""}`,
      ) ?? null,
    sandbox_size: cloud?.sandboxSize ?? null,
    mcp_config: args.mcp ?? null,
    worker_session_id: null,
    status: "running",
  };
  return () => {
    const write = createSubagentWriter(input, actingUserId);
    let previous: string | undefined;
    let stopped = false;
    return (state) => {
      const links: SubagentLinks =
        harness === "letta"
          ? {
              ...(state.agentId ? { agent_id: state.agentId } : {}),
              ...(state.conversationId && state.conversationId !== "default"
                ? { conversation_id: state.conversationId }
                : {}),
            }
          : state.agentId
            ? { worker_session_id: state.agentId }
            : {};
      const status: PersistedSubagentStatus = stopped
        ? "stopped"
        : persistedSubagentStatus(state);
      stopped = status === "stopped";
      const change = { ...links, status };
      const serialized = JSON.stringify(change);
      if (serialized === previous) return;
      previous = serialized;
      write(change);
    };
  };
}

export function persistedSubagentStatus(
  state: SubagentState,
): PersistedSubagentStatus {
  if (state.stopOutcome?.kind === "stopped") return "stopped";
  if (state.status === "error" && !state.cancelPending) return "failed";
  if (state.status === "completed") return "completed";
  return "running";
}
