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

export function isSlackRuntimeInstalled(): boolean {
  return isChannelRuntimeInstalled("slack");
}

export async function installSlackRuntime(): Promise<void> {
  await installChannelRuntime("slack");
}

export async function ensureSlackRuntimeInstalled(): Promise<boolean> {
  return ensureChannelRuntimeInstalled("slack");
}
