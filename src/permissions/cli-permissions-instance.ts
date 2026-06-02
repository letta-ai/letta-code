/**
 * Singleton instance of CliPermissions.
 *
 * Keep this on globalThis instead of as a module-local singleton. The bundled
 * CLI can contain more than one copy of this module when multiple entrypoint
 * graphs are included (interactive + headless). Startup may set or clear
 * --disable-memory-guard state through one copy while permission checks read
 * from another; a global symbol makes those copies share the same state.
 */
import { CliPermissions } from "./cli";

const CLI_PERMISSIONS_KEY = Symbol.for("@letta/cliPermissions");

type GlobalWithCliPermissions = typeof globalThis & {
  [CLI_PERMISSIONS_KEY]?: CliPermissions;
};

function getCliPermissions(): CliPermissions {
  const state = globalThis as GlobalWithCliPermissions;
  state[CLI_PERMISSIONS_KEY] ??= new CliPermissions();
  return state[CLI_PERMISSIONS_KEY];
}

export const cliPermissions = getCliPermissions();
