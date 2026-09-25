import { isLocalAgentId } from "@/agent/agent-id";
import {
  configureBackendMode,
  isExperimentalLocalBackendEnabled,
} from "@/backend";

export type StartupBackendMode = "api" | "local";

export function inferBackendModeFromAgentId(
  agentId?: string | null,
): StartupBackendMode | undefined {
  if (!agentId) return undefined;
  return isLocalAgentId(agentId) ? "local" : "api";
}

/** The startup picker lists pins from both backends, even when Cloud is active. */
export async function switchBackendForSelectedStartupAgent(
  agentId: string,
  tryConfigureLocal: () => Promise<boolean>,
): Promise<boolean> {
  if (isLocalAgentId(agentId)) {
    if (isExperimentalLocalBackendEnabled()) return true;
    try {
      return await tryConfigureLocal();
    } catch (error) {
      configureBackendMode("api");
      throw error;
    }
  }
  if (isExperimentalLocalBackendEnabled()) configureBackendMode("api");
  return true;
}

export function createStartupAgentPickerHandler(
  tryConfigureLocal: () => Promise<boolean>,
  selectAgent: (agentId: string) => void,
  onReady: () => void,
  onError: (message: string) => void,
): (agentId: string) => Promise<void> {
  return async (agentId) => {
    try {
      const ready = await switchBackendForSelectedStartupAgent(
        agentId,
        tryConfigureLocal,
      );
      if (!ready) {
        onError("Local backend data needs migration.");
        return;
      }
      selectAgent(agentId);
      onReady();
    } catch (error) {
      onError(
        `Unable to select agent: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
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
