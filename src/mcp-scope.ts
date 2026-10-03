import { getRuntimeContext } from "@/runtime-context";
import { getRuntimeExecutionEnv } from "@/runtime-execution-settings";

/** MCP resource scope is separate from the worker's conversation identity. */
export function getMcpScopeAgentId(
  agentId: string,
  env = getRuntimeExecutionEnv(
    process.env,
    getRuntimeContext()?.executionSettings,
  ),
): string {
  return env.LETTA_MCP_AGENT_ID?.trim() || agentId;
}
