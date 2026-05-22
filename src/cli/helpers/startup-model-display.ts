const STARTUP_NO_MODEL_LABEL = "No model selected";

export function getStartupModelDisplayOverride(options: {
  isLocalBackend: boolean;
  startupHasAvailableLocalModels: boolean;
}): string | null {
  const { isLocalBackend, startupHasAvailableLocalModels } = options;

  if (isLocalBackend && !startupHasAvailableLocalModels) {
    return STARTUP_NO_MODEL_LABEL;
  }

  return null;
}
