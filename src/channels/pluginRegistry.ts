import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { getChannelDir, getChannelsRoot } from "./config";
import type { ChannelPlugin, ChannelPluginMetadata } from "./pluginTypes";
import { FIRST_PARTY_CHANNEL_IDS, type FirstPartyChannelId } from "./types";

type ChannelPluginRegistration = {
  metadata: ChannelPluginMetadata;
  load: () => Promise<ChannelPlugin>;
};

type ChannelManifest = {
  id: string;
  displayName: string;
  entry: string;
  runtimePackages: string[];
  runtimeModules: string[];
};

const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const FIRST_PARTY_CHANNEL_PLUGIN_REGISTRATIONS: Record<
  FirstPartyChannelId,
  ChannelPluginRegistration
> = {
  telegram: {
    metadata: {
      id: "telegram",
      displayName: "Telegram",
      runtimePackages: ["grammy@1.42.0"],
      runtimeModules: ["grammy"],
      source: "first-party",
      firstParty: true,
    },
    load: async () => {
      const { telegramChannelPlugin } = await import("./telegram/plugin");
      return telegramChannelPlugin;
    },
  },
  slack: {
    metadata: {
      id: "slack",
      displayName: "Slack",
      runtimePackages: ["@slack/bolt@4.7.0", "@slack/web-api@7.15.0"],
      runtimeModules: ["@slack/bolt", "@slack/web-api"],
      source: "first-party",
      firstParty: true,
    },
    load: async () => {
      const { slackChannelPlugin } = await import("./slack/plugin");
      return slackChannelPlugin;
    },
  },
  discord: {
    metadata: {
      id: "discord",
      displayName: "Discord",
      runtimePackages: ["discord.js@14.18.0"],
      runtimeModules: ["discord.js"],
      source: "first-party",
      firstParty: true,
    },
    load: async () => {
      const { discordChannelPlugin } = await import("./discord/plugin");
      return discordChannelPlugin;
    },
  },
};

const loadedUserPlugins = new Map<string, Promise<ChannelPlugin>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidChannelId(value: string): boolean {
  return CHANNEL_ID_PATTERN.test(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readChannelManifest(channelDir: string): ChannelManifest | null {
  const manifestPath = resolve(channelDir, "channel.json");
  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
    const displayName =
      typeof parsed.displayName === "string" ? parsed.displayName.trim() : "";
    const entry = typeof parsed.entry === "string" ? parsed.entry.trim() : "";
    if (!id || !displayName || !entry || !isValidChannelId(id)) {
      return null;
    }

    return {
      id,
      displayName,
      entry,
      runtimePackages: readStringArray(parsed.runtimePackages),
      runtimeModules: readStringArray(parsed.runtimeModules),
    };
  } catch {
    return null;
  }
}

function createUserChannelRegistration(
  manifest: ChannelManifest,
): ChannelPluginRegistration {
  const channelDir = getChannelDir(manifest.id);
  const entryPath = resolve(channelDir, manifest.entry);
  const resolvedChannelDir = resolve(channelDir);
  const entryEscapesDir =
    entryPath !== resolvedChannelDir &&
    !entryPath.startsWith(`${resolvedChannelDir}${sep}`);
  const metadata: ChannelPluginMetadata = {
    id: manifest.id,
    displayName: manifest.displayName,
    runtimePackages: manifest.runtimePackages,
    runtimeModules: manifest.runtimeModules,
    source: "user",
    firstParty: false,
  };

  return {
    metadata,
    load: async () => {
      const cached = loadedUserPlugins.get(manifest.id);
      if (cached) {
        return cached;
      }
      if (entryEscapesDir) {
        throw new Error(
          `Channel plugin "${manifest.id}" entry escapes its directory.`,
        );
      }

      const loadPromise = import(pathToFileURL(entryPath).href).then(
        (loaded): ChannelPlugin => {
          const exported =
            (isRecord(loaded) ? loaded.channelPlugin : undefined) ??
            (isRecord(loaded) ? loaded.default : undefined);
          if (!isRecord(exported)) {
            throw new Error(
              `Channel plugin "${manifest.id}" must export channelPlugin or default.`,
            );
          }

          const plugin = exported as unknown as ChannelPlugin;
          if (typeof plugin.createAdapter !== "function") {
            throw new Error(
              `Channel plugin "${manifest.id}" is missing createAdapter().`,
            );
          }

          return {
            ...plugin,
            metadata: {
              ...metadata,
              ...(plugin.metadata ?? {}),
              id: manifest.id,
              displayName: plugin.metadata?.displayName ?? metadata.displayName,
              source: "user",
              firstParty: false,
            },
          };
        },
      );
      loadedUserPlugins.set(manifest.id, loadPromise);
      return loadPromise;
    },
  };
}

function discoverUserChannelRegistrations(): Map<
  string,
  ChannelPluginRegistration
> {
  const registrations = new Map<string, ChannelPluginRegistration>();
  const channelsRoot = getChannelsRoot();
  if (!existsSync(channelsRoot)) {
    return registrations;
  }

  let entries: string[];
  try {
    entries = readdirSync(channelsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return registrations;
  }

  for (const entry of entries) {
    if (!isValidChannelId(entry)) {
      continue;
    }
    if (Object.hasOwn(FIRST_PARTY_CHANNEL_PLUGIN_REGISTRATIONS, entry)) {
      continue;
    }

    const manifest = readChannelManifest(getChannelDir(entry));
    if (!manifest || manifest.id !== entry) {
      continue;
    }
    registrations.set(manifest.id, createUserChannelRegistration(manifest));
  }

  return registrations;
}

function getChannelPluginRegistration(
  channelId: string,
): ChannelPluginRegistration | null {
  if (Object.hasOwn(FIRST_PARTY_CHANNEL_PLUGIN_REGISTRATIONS, channelId)) {
    return FIRST_PARTY_CHANNEL_PLUGIN_REGISTRATIONS[
      channelId as FirstPartyChannelId
    ];
  }
  return discoverUserChannelRegistrations().get(channelId) ?? null;
}

export function isSupportedChannelId(value: string): value is string {
  return getChannelPluginRegistration(value) !== null;
}

export function getSupportedChannelIds(): string[] {
  const discovered = discoverUserChannelRegistrations();
  return [
    ...FIRST_PARTY_CHANNEL_IDS,
    ...[...discovered.keys()].sort((left, right) => left.localeCompare(right)),
  ];
}

export function getChannelPluginMetadata(
  channelId: string,
): ChannelPluginMetadata {
  const registration = getChannelPluginRegistration(channelId);
  if (!registration) {
    throw new Error(`Unsupported channel: ${channelId}`);
  }
  return registration.metadata;
}

export function getChannelDisplayName(channelId: string): string {
  return getChannelPluginMetadata(channelId).displayName;
}

export function isFirstPartyChannelPlugin(channelId: string): boolean {
  return Object.hasOwn(FIRST_PARTY_CHANNEL_PLUGIN_REGISTRATIONS, channelId);
}

export async function loadChannelPlugin(
  channelId: string,
): Promise<ChannelPlugin> {
  const registration = getChannelPluginRegistration(channelId);
  if (!registration) {
    throw new Error(`Unsupported channel: ${channelId}`);
  }
  return registration.load();
}

export function __testClearUserChannelPluginCache(): void {
  loadedUserPlugins.clear();
}
