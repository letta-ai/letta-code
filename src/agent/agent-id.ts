export type AgentBackendMode = "local" | "api";

export function isLocalAgentId(agentId: string): boolean {
  return agentId.startsWith("agent-local-");
}

export function isCloudAgentId(agentId: string): boolean {
  return !isLocalAgentId(agentId);
}

export function isAgentIdCompatibleWithBackend(
  agentId: string,
  backendMode: AgentBackendMode,
): boolean {
  return backendMode === "local"
    ? isLocalAgentId(agentId)
    : isCloudAgentId(agentId);
}
