const STARTUP_NO_MODEL_LABEL = "No model selected";

export function shouldHideReasoningForModelDisplay(
  modelDisplay: string | null | undefined,
): boolean {
  return modelDisplay === STARTUP_NO_MODEL_LABEL;
}

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
