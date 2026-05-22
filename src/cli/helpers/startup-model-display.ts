import type { AgentProvenance } from "@/agent/create";

const STARTUP_NO_MODEL_LABEL = "No model selected";

export function getStartupModelDisplayOverride(options: {
  isLocalBackend: boolean;
  startupHasAvailableLocalModels: boolean;
  agentProvenance: AgentProvenance | null | undefined;
}): string | null {
  const { isLocalBackend, startupHasAvailableLocalModels, agentProvenance } =
    options;

  if (
    isLocalBackend &&
    !startupHasAvailableLocalModels &&
    agentProvenance?.isNew
  ) {
    return STARTUP_NO_MODEL_LABEL;
  }

  return null;
}
