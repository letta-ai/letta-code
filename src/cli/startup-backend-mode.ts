import { isLocalAgentId } from "@/agent/agent-id";

export function inferBackendModeFromAgentId(
  agentId?: string | null,
): "api" | "local" | undefined {
  if (!agentId) return undefined;
  return isLocalAgentId(agentId) ? "local" : "api";
}
