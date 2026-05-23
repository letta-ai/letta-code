/**
 * Pure predicate for gating reflection-subagent launches.
 *
 * Shared by `src/cli/App.tsx` (desktop app path) and
 * `src/websocket/listener/turn.ts` (websocket listener path) so both
 * paths use the same definition of "a reflection is active for my
 * scope." Scoping by parent agent + conversation avoids the
 * global-gate bug where one agent's stuck reflection poisons
 * auto-launch for every other agent in the process.
 */

type ReflectionGateSubagent = {
  type: string;
  status: "pending" | "running" | "completed" | "error";
  parentAgentId?: string;
  parentConversationId?: string;
};

/**
 * Returns true iff a reflection subagent that belongs to
 * (`agentId`, `conversationId`) is currently pending or running.
 *
 * A missing `parentConversationId` on a subagent is treated as
 * `"default"` to match the convention used elsewhere in the runtime.
 */
export function isReflectionSubagentActive(
  subagents: ReflectionGateSubagent[],
  agentId: string,
  conversationId: string,
): boolean {
  return subagents.some((agent) => {
    if (agent.type.toLowerCase() !== "reflection") {
      return false;
    }
    if (agent.status !== "pending" && agent.status !== "running") {
      return false;
    }
    if (!agent.parentAgentId) {
      return false;
    }
    const parentConversationId = agent.parentConversationId ?? "default";
    return (
      agent.parentAgentId === agentId && parentConversationId === conversationId
    );
  });
}
