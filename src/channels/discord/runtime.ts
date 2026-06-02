import {
  ensureChannelRuntimeInstalled,
  installChannelRuntime,
  isChannelRuntimeInstalled,
  loadChannelRuntimeModule,
} from "@/channels/runtime-deps";

export interface DiscordGatewayIntentBitsLike {
  Guilds: unknown;
  GuildMessages: unknown;
  GuildMessageReactions: unknown;
  MessageContent: unknown;
  DirectMessages: unknown;
  DirectMessageReactions: unknown;
}

export interface DiscordPartialsLike {
  Channel: unknown;
  Message: unknown;
  Reaction: unknown;
  User: unknown;
}

export interface DiscordRuntimeModuleLike {
  Client: new (options: {
    intents: unknown[];
    partials?: unknown[];
  }) => unknown;
  GatewayIntentBits: DiscordGatewayIntentBitsLike;
  Partials: DiscordPartialsLike;
}

let loadDiscordModuleOverride:
  | (() => Promise<DiscordRuntimeModuleLike>)
  | null = null;

export function __testOverrideLoadDiscordModule(
  override: (() => Promise<DiscordRuntimeModuleLike>) | null,
): void {
  loadDiscordModuleOverride = override;
}

export async function loadDiscordModule(): Promise<DiscordRuntimeModuleLike> {
  if (loadDiscordModuleOverride) {
    return loadDiscordModuleOverride();
  }
  return loadChannelRuntimeModule<DiscordRuntimeModuleLike>(
    "discord",
    "discord.js",
  );
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
