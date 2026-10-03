import { LETTA_CODE_SUBAGENT_TAG } from "@/agent/agent-tags";
import { getBackend } from "@/backend";
import { getRuntimeContext } from "@/runtime-context";
import { getRuntimeExecutionEnv } from "@/runtime-execution-settings";

export type ParentAgentLookup = (
  agentId: string,
) => Promise<string | undefined>;

async function lookupParentAgent(agentId: string): Promise<string | undefined> {
  const agent = await getBackend().retrieveAgent(agentId, {
    include: ["agent.tags"],
  });
  if (!agent.tags?.includes(LETTA_CODE_SUBAGENT_TAG)) return undefined;
  return agent.tags
    .find((tag) => tag.startsWith("parent:"))
    ?.slice("parent:".length);
}

/** Follow the existing subagent parent relationship, without changing identity. */
export async function getMcpScopeAgentId(
  agentId: string,
  env = getRuntimeExecutionEnv(
    process.env,
    getRuntimeContext()?.executionSettings,
  ),
  lookupParent: ParentAgentLookup = lookupParentAgent,
): Promise<string> {
  if (env.LETTA_CODE_AGENT_ROLE !== "subagent" || !env.LETTA_PARENT_AGENT_ID)
    return agentId;
  const visited = new Set<string>();
  while (!visited.has(agentId)) {
    visited.add(agentId);
    const parentId = await lookupParent(agentId);
    if (!parentId) return agentId;
    agentId = parentId;
  }
  throw new Error("Subagent parent cycle while resolving MCP inheritance");
}
