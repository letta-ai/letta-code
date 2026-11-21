// Manages user settings and project settings in ./.letta/settings.local.json

import { join } from "node:path";
import type { PermissionRules } from "./permissions/types";
import { exists, mkdir, readFile, writeFile } from "./utils/fs.js";
import {
  resolveGlobalSettingsPath,
  shouldIsolateHomeProjectConfig,
} from "./utils/settings-path.js";

export interface Settings {
  lastAgent: string | null;
  tokenStreaming: boolean;
  globalSharedBlockIds: Record<string, string>; // label -> blockId mapping (persona, human; style moved to project settings)
  permissions?: PermissionRules;
  env?: Record<string, string>;
  shiftEnterKeybindingInstalled?: boolean;
  wezTermDeleteFixInstalled?: boolean;
}

export interface ProjectSettings {
  lastAgent: string | null;
  permissions?: PermissionRules;
}

const DEFAULT_SETTINGS: Settings = {
  lastAgent: null,
  tokenStreaming: false,
  globalSharedBlockIds: {},
};

function getSettingsPath(): string {
  return resolveGlobalSettingsPath();
}

export async function loadSettings(): Promise<Settings> {
  const settingsPath = getSettingsPath();

  try {
    if (!exists(settingsPath)) {
      await saveSettings(DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    }

    const content = await readFile(settingsPath);
    const settings = JSON.parse(content) as Settings;

    // Merge with defaults in case new fields were added
    return { ...DEFAULT_SETTINGS, ...settings };
  } catch (error) {
    console.error("Error loading settings, using defaults:", error);
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  const settingsPath = getSettingsPath();

  try {
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), {
      directoryMode: 0o700,
      mode: 0o600,
    });
  } catch (error) {
    console.error("Error saving settings:", error);
    throw error;
  }
}

export async function updateSettings(
  updates: Partial<Settings>,
): Promise<Settings> {
  const currentSettings = await loadSettings();
  const newSettings = { ...currentSettings, ...updates };
  await saveSettings(newSettings);
  return newSettings;
}

export async function getSetting<K extends keyof Settings>(
  key: K,
): Promise<Settings[K]> {
  const settings = await loadSettings();
  return settings[key];
}

function getProjectSettingsPath(): string {
  return join(process.cwd(), ".letta", "settings.local.json");
}

export async function loadProjectSettings(): Promise<ProjectSettings | null> {
  if (shouldIsolateHomeProjectConfig(process.cwd())) return null;
  const settingsPath = getProjectSettingsPath();

  try {
    if (!exists(settingsPath)) {
      return null;
    }

    const content = await readFile(settingsPath);
    const settings = JSON.parse(content) as ProjectSettings;
    return settings;
  } catch (error) {
    console.error("Error loading project settings:", error);
    return null;
  }
}

export async function saveProjectSettings(
  settings: ProjectSettings,
): Promise<void> {
  if (shouldIsolateHomeProjectConfig(process.cwd())) return;
  const settingsPath = getProjectSettingsPath();
  const dirPath = join(process.cwd(), ".letta");

  try {
    if (!exists(dirPath)) {
      await mkdir(dirPath, { recursive: true });
    }

    await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error("Error saving project settings:", error);
    throw error;
  }
}

export async function updateProjectSettings(
  updates: Partial<ProjectSettings>,
): Promise<ProjectSettings> {
  const currentSettings = (await loadProjectSettings()) || { lastAgent: null };
  const newSettings = { ...currentSettings, ...updates };
  await saveProjectSettings(newSettings);
  return newSettings;
}
