import {
  ensureChannelRuntimeInstalled,
  installChannelRuntime,
  isChannelRuntimeInstalled,
  loadChannelRuntimeModule,
} from "../runtimeDeps";

export async function loadSlackBoltModule(): Promise<
  typeof import("@slack/bolt")
> {
  return loadChannelRuntimeModule<typeof import("@slack/bolt")>(
    "slack",
    "@slack/bolt",
  );
}

export async function loadSlackWebApiModule(): Promise<
  typeof import("@slack/web-api")
> {
  return loadChannelRuntimeModule<typeof import("@slack/web-api")>(
    "slack",
    "@slack/web-api",
  );
}

export function isSlackRuntimeInstalled(): boolean {
  return isChannelRuntimeInstalled("slack");
}

export async function installSlackRuntime(): Promise<void> {
  await installChannelRuntime("slack");
}

export async function ensureSlackRuntimeInstalled(): Promise<boolean> {
  return ensureChannelRuntimeInstalled("slack");
}
