import {
  ensureChannelRuntimeInstalled,
  installChannelRuntime,
  isChannelRuntimeInstalled,
  loadChannelRuntimeModule,
} from "@/channels/runtime-deps";

let loadGrammyModuleOverride: (() => Promise<typeof import("grammy")>) | null =
  null;

export function __testOverrideLoadGrammyModule(
  factory: (() => Promise<typeof import("grammy")>) | null,
): void {
  loadGrammyModuleOverride = factory;
}

export async function loadGrammyModule(): Promise<typeof import("grammy")> {
  if (loadGrammyModuleOverride) return loadGrammyModuleOverride();
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
