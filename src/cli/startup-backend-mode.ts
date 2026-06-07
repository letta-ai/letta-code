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

export interface SubcommandBackendModeInput {
  explicitBackendMode?: StartupBackendMode;
  envBackendMode?: StartupBackendMode;
  savedBackendMode?: StartupBackendMode;
  baseURL: string;
  cloudBaseURL: string;
}

export function resolveSubcommandBackendMode({
  explicitBackendMode,
  envBackendMode,
  savedBackendMode,
  baseURL,
  cloudBaseURL,
}: SubcommandBackendModeInput): StartupBackendMode | undefined {
  if (explicitBackendMode) return undefined;
  if (envBackendMode) return envBackendMode;
  if (!savedBackendMode) return undefined;
  if (savedBackendMode === "local" && baseURL !== cloudBaseURL) {
    return undefined;
  }
  return savedBackendMode;
}
