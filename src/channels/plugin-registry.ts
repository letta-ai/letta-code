import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRecord } from "@/utils/type-guards";
import { getChannelDir, getChannelsRoot } from "./config";
import { CUSTOM_CHANNEL_CONFIG_SCHEMA } from "./custom/plugin";
import type {
  ChannelConfigSchema,
  ChannelPlugin,
  ChannelPluginMetadata,
} from "./plugin-types";
import { parseChannelConfigSchema } from "./schema-config";
import { FIRST_PARTY_CHANNEL_IDS, type FirstPartyChannelId } from "./types";

export type LoadChannelPluginOptions = {
  forceReload?: boolean;
};

type ChannelPluginRegistration = {
  metadata: ChannelPluginMetadata;
  load: (options?: LoadChannelPluginOptions) => Promise<ChannelPlugin>;
};

type ChannelManifest = {
  id: string;
  displayName: string;
  entry: string;
  runtimePackages: string[];
  runtimeModules: string[];
  configSchema?: ChannelConfigSchema;
};

const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
let pluginReloadGeneration = 0;
const SOURCE_CHANNELS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT_DIR = resolve(SOURCE_CHANNELS_DIR, "../..");
let sourceChannelsDirOverride: string | null = null;

function rewriteCopiedChannelSelfImports(
  channelDir: string,
  channelId: FirstPartyChannelId,
): void {
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) continue;

      const source = readFileSync(path, "utf8");
      const relativeRoot = relative(dirname(path), channelDir).replaceAll(
        sep,
        "/",
      );
      const localPrefix =
        relativeRoot.length === 0
          ? "./"
          : relativeRoot.startsWith(".")
            ? `${relativeRoot}/`
            : `./${relativeRoot}/`;
      const rewritten = source.replaceAll(
        `@/channels/${channelId}/`,
        localPrefix,
      );
      if (rewritten !== source) writeFileSync(path, rewritten);
    }
  };
  visit(channelDir);
}

function copyFirstPartyChannelForReload(
  channelId: FirstPartyChannelId,
): string | null {
  const sourceDir = resolve(
    sourceChannelsDirOverride ?? SOURCE_CHANNELS_DIR,
    channelId,
  );
  if (!existsSync(sourceDir)) return null;

  pluginReloadGeneration += 1;
  const targetDir = resolve(
    PROJECT_ROOT_DIR,
    ".letta",
    "channel-reload",
    `${process.pid}-${pluginReloadGeneration}`,
    channelId,
  );
  mkdirSync(dirname(targetDir), { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true, force: true });
  rewriteCopiedChannelSelfImports(targetDir, channelId);
  return targetDir;
}

async function loadFirstPartyPlugin(params: {
  channelId: FirstPartyChannelId;
  exportName: string;
  forceReload?: boolean;
  loadDefault: () => Promise<unknown>;
}): Promise<ChannelPlugin> {
  const reloadDir = params.forceReload
    ? copyFirstPartyChannelForReload(params.channelId)
    : null;
  const loaded = reloadDir
    ? await import(pathToFileURL(resolve(reloadDir, "plugin.ts")).href)
    : await params.loadDefault();
  const plugin = isRecord(loaded) ? loaded[params.exportName] : undefined;
  if (!isRecord(plugin)) {
    throw new Error(
      `First-party channel ${params.channelId} did not export ${params.exportName}.`,
    );
  }
  return plugin as unknown as ChannelPlugin;
}

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
    load: (options) =>
      loadFirstPartyPlugin({
        channelId: "telegram",
        exportName: "telegramChannelPlugin",
        forceReload: options?.forceReload,
        loadDefault: () => import("@/channels/telegram/plugin"),
      }),
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
    load: (options) =>
      loadFirstPartyPlugin({
        channelId: "slack",
        exportName: "slackChannelPlugin",
        forceReload: options?.forceReload,
        loadDefault: () => import("@/channels/slack/plugin"),
      }),
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
    load: (options) =>
      loadFirstPartyPlugin({
        channelId: "discord",
        exportName: "discordChannelPlugin",
        forceReload: options?.forceReload,
        loadDefault: () => import("@/channels/discord/plugin"),
      }),
  },
  custom: {
    metadata: {
      id: "custom",
      displayName: "Custom",
      runtimePackages: [],
      runtimeModules: [],
      source: "first-party",
      firstParty: true,
      configSchema: CUSTOM_CHANNEL_CONFIG_SCHEMA,
    },
    load: (options) =>
      loadFirstPartyPlugin({
        channelId: "custom",
        exportName: "customChannelPlugin",
        forceReload: options?.forceReload,
        loadDefault: () => import("@/channels/custom/plugin"),
      }),
  },
  whatsapp: {
    metadata: {
      id: "whatsapp",
      displayName: "WhatsApp",
      runtimePackages: [
        "@whiskeysockets/baileys@6.7.21",
        "qrcode-terminal@0.12.0",
      ],
      runtimeModules: ["@whiskeysockets/baileys", "qrcode-terminal"],
      source: "first-party",
      firstParty: true,
    },
    load: (options) =>
      loadFirstPartyPlugin({
        channelId: "whatsapp",
        exportName: "whatsappChannelPlugin",
        forceReload: options?.forceReload,
        loadDefault: () => import("@/channels/whatsapp/plugin"),
      }),
  },
  signal: {
    metadata: {
      id: "signal",
      displayName: "Signal",
      runtimePackages: ["qrcode-terminal@0.12.0"],
      runtimeModules: ["qrcode-terminal"],
      source: "first-party",
      firstParty: true,
    },
    load: (options) =>
      loadFirstPartyPlugin({
        channelId: "signal",
        exportName: "signalChannelPlugin",
        forceReload: options?.forceReload,
        loadDefault: () => import("@/channels/signal/plugin"),
      }),
  },
};

const loadedPlugins = new Map<string, Promise<ChannelPlugin>>();

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

    const configSchema = parseChannelConfigSchema(parsed.configSchema);

    return {
      id,
      displayName,
      entry,
      runtimePackages: readStringArray(parsed.runtimePackages),
      runtimeModules: readStringArray(parsed.runtimeModules),
      configSchema: configSchema ?? undefined,
    };
  } catch {
    return null;
  }
}

function buildFreshUserPluginImportHref(params: {
  channelDir: string;
  entry: string;
  id: string;
}): string {
  const cacheDir = mkdtempSync(
    join(tmpdir(), `letta-channel-plugin-${params.id}-`),
  );
  cpSync(params.channelDir, cacheDir, { recursive: true, force: true });
  return pathToFileURL(resolve(cacheDir, params.entry)).href;
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
    configSchema: manifest.configSchema,
  };

  return {
    metadata,
    load: async (options) => {
      if (entryEscapesDir) {
        throw new Error(
          `Channel plugin "${manifest.id}" entry escapes its directory.`,
        );
      }

      const importHref = options?.forceReload
        ? buildFreshUserPluginImportHref({
            channelDir: resolvedChannelDir,
            entry: manifest.entry,
            id: manifest.id,
          })
        : pathToFileURL(entryPath).href;
      return import(importHref).then((loaded): ChannelPlugin => {
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
      });
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
  options?: LoadChannelPluginOptions,
): Promise<ChannelPlugin> {
  const cached = loadedPlugins.get(channelId);
  if (cached && !options?.forceReload) return cached;

  const registration = getChannelPluginRegistration(channelId);
  if (!registration) {
    throw new Error(`Unsupported channel: ${channelId}`);
  }
  const loadPromise = registration.load(options);
  loadedPlugins.set(channelId, loadPromise);
  loadPromise.catch(() => {
    if (cached) {
      loadedPlugins.set(channelId, cached);
    } else {
      loadedPlugins.delete(channelId);
    }
  });
  return loadPromise;
}

export type ChannelPluginCacheSnapshot = Map<
  string,
  Promise<ChannelPlugin> | null
>;

export function snapshotChannelPluginCache(
  channelIds: Iterable<string>,
): ChannelPluginCacheSnapshot {
  const snapshot: ChannelPluginCacheSnapshot = new Map();
  for (const channelId of channelIds) {
    snapshot.set(channelId, loadedPlugins.get(channelId) ?? null);
  }
  return snapshot;
}

export function restoreChannelPluginCache(
  snapshot: ChannelPluginCacheSnapshot,
): void {
  for (const [channelId, cached] of snapshot) {
    if (cached) {
      loadedPlugins.set(channelId, cached);
    } else {
      loadedPlugins.delete(channelId);
    }
  }
}

export function invalidateChannelPluginCache(channelId?: string): void {
  if (channelId) {
    loadedPlugins.delete(channelId);
    return;
  }
  loadedPlugins.clear();
}

export function __testClearUserChannelPluginCache(): void {
  invalidateChannelPluginCache();
  pluginReloadGeneration = 0;
  sourceChannelsDirOverride = null;
}

export function __testOverrideFirstPartySourceChannelsDir(
  directory: string | null,
): void {
  sourceChannelsDirOverride = directory;
}
