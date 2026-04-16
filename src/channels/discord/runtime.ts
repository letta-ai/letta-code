import {
  ensureChannelRuntimeInstalled,
  installChannelRuntime,
  isChannelRuntimeInstalled,
  loadChannelRuntimeModule,
} from "../runtimeDeps";

// biome-ignore lint/suspicious/noExplicitAny: discord.js is a runtime dependency
export async function loadDiscordModule(): Promise<any> {
  return loadChannelRuntimeModule("discord", "discord.js");
}

export function isDiscordRuntimeInstalled(): boolean {
  return isChannelRuntimeInstalled("discord");
}

export async function installDiscordRuntime(): Promise<void> {
  await installChannelRuntime("discord");
}

export async function ensureDiscordRuntimeInstalled(): Promise<boolean> {
  return ensureChannelRuntimeInstalled("discord");
}
