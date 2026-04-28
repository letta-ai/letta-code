import {
  ensureChannelRuntimeInstalled,
  installChannelRuntime,
  isChannelRuntimeInstalled,
  loadChannelRuntimeModule,
} from "../runtimeDeps";

export async function loadGrammyModule(): Promise<typeof import("grammy")> {
  return loadChannelRuntimeModule<typeof import("grammy")>(
    "telegram",
    "grammy",
  );
}

export function isTelegramRuntimeInstalled(): boolean {
  return isChannelRuntimeInstalled("telegram");
}

export async function installTelegramRuntime(): Promise<void> {
  await installChannelRuntime("telegram");
}

export async function ensureTelegramRuntimeInstalled(): Promise<boolean> {
  return ensureChannelRuntimeInstalled("telegram");
}
