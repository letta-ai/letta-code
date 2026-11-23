import { isLocalBackendEnvEnabled } from "./local/paths";

export type BackendMode = "api" | "local";

let configuredBackendMode: BackendMode | null = null;

export function resolveBackendMode(): BackendMode {
  return (
    configuredBackendMode ?? (isLocalBackendEnvEnabled() ? "local" : "api")
  );
}

export function setConfiguredBackendMode(mode: BackendMode): void {
  configuredBackendMode = mode;
}

export function isExperimentalLocalBackendEnabled(): boolean {
  return resolveBackendMode() === "local";
}
