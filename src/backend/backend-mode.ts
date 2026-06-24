/**
 * Single source of truth for the active backend mode.
 *
 * Lives in its own leaf module (no `backend.ts` deps) so low-level consumers
 * like `settings-manager` can read the mode directly instead of inferring it
 * from the `LETTA_LOCAL_BACKEND_EXPERIMENTAL` env var. The runtime override set
 * via `setConfiguredBackendMode` takes precedence; otherwise we fall back to the
 * experimental local-backend env flag.
 */
import { isLocalBackendEnvEnabled } from "./local/paths";

export type BackendMode = "api" | "local";

let configuredBackendMode: BackendMode | null = null;

/**
 * Resolve the active backend mode: an explicit runtime override if one was set,
 * otherwise the experimental local-backend env flag.
 */
export function resolveBackendMode(): BackendMode {
  return (
    configuredBackendMode ?? (isLocalBackendEnvEnabled() ? "local" : "api")
  );
}

/**
 * Set the active backend mode override. Callers that also need to swap the live
 * backend instance should use `configureBackendMode` from `@/backend` instead.
 */
export function setConfiguredBackendMode(mode: BackendMode): void {
  configuredBackendMode = mode;
}

export function isExperimentalLocalBackendEnabled(): boolean {
  return resolveBackendMode() === "local";
}
