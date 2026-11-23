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
