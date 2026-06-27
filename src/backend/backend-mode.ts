/**
 * Single source of truth for the active backend mode.
 *
 * Kept in its own leaf module so the mode state + resolver don't sit among
 * `backend.ts`'s backend-class imports, and so the mode can be read without
 * pulling in the full backend module. The runtime override set via
 * `setConfiguredBackendMode` takes precedence; otherwise we fall back to the
 * experimental local-backend env flag.
 *
 * Note: settings namespacing intentionally does NOT read this — it stays on the
 * env-based predicate (`isLocalBackendEnvEnabled`) so it isn't coupled to this
 * mutable global, which leaks across test files.
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
