import {
  ensureChannelRuntimeInstalled,
  installChannelRuntime,
  isChannelRuntimeInstalled,
  loadChannelRuntimeModule,
} from "../runtimeDeps";

export async function loadGrammyModule<T>(): Promise<T> {
  return loadChannelRuntimeModule<T>("telegram");
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
