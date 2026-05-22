import { isLocalAgentId } from "@/agent/agent-id";

export type StartupBackendMode = "api" | "local";

export function inferBackendModeFromAgentId(
  agentId?: string | null,
): StartupBackendMode | undefined {
  if (!agentId) return undefined;
  return isLocalAgentId(agentId) ? "local" : "api";
}

export function getStartupBackendLookupOrder(
  activeMode: StartupBackendMode,
  explicitMode?: StartupBackendMode,
): StartupBackendMode[] {
  if (explicitMode) return [explicitMode];
  return activeMode === "local" ? ["local", "api"] : ["api", "local"];
}
