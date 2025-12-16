// src/settings.ts
// Manages user settings stored in ~/.letta/settings.json and project settings in ./.letta/settings.local.json

import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionRules } from "./permissions/types";
import { exists, mkdir, readFile, writeFile } from "./utils/fs.js";

export interface Settings {
  lastAgent: string | null;
  tokenStreaming: boolean;
  globalSharedBlockIds: Record<string, string>; // label -> blockId mapping (persona, human; style moved to project settings)
  permissions?: PermissionRules;
  env?: Record<string, string>;
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
  return join(homedir(), ".letta", "settings.json");
}

/**
 * Load settings from ~/.letta/settings.json
 * If the file doesn't exist, creates it with default settings
 */
export async function loadSettings(): Promise<Settings> {
  const settingsPath = getSettingsPath();

  try {
    // Check if settings file exists
    if (!exists(settingsPath)) {
      // Create default settings file
      await saveSettings(DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    }

    // Read and parse settings
    const content = await readFile(settingsPath);
    const settings = JSON.parse(content) as Settings;

    // Merge with defaults in case new fields were added
    return { ...DEFAULT_SETTINGS, ...settings };
  } catch (error) {
    console.error("Error loading settings, using defaults:", error);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Save settings to ~/.letta/settings.json
 */
export async function saveSettings(settings: Settings): Promise<void> {
  const settingsPath = getSettingsPath();

  try {
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error("Error saving settings:", error);
    throw error;
  }
}

/**
 * Update specific settings fields
 */
export async function updateSettings(
  updates: Partial<Settings>,
): Promise<Settings> {
  const currentSettings = await loadSettings();
  const newSettings = { ...currentSettings, ...updates };
  await saveSettings(newSettings);
  return newSettings;
}

/**
 * Get a specific setting value
 */
export async function getSetting<K extends keyof Settings>(
  key: K,
): Promise<Settings[K]> {
  const settings = await loadSettings();
  return settings[key];
}

/**
 * Get project settings path (./.letta/settings.local.json)
 */
function getProjectSettingsPath(): string {
  return join(process.cwd(), ".letta", "settings.local.json");
}

/**
 * Load project settings from ./.letta/settings.local.json
 * Returns null if file doesn't exist
 */
export async function loadProjectSettings(): Promise<ProjectSettings | null> {
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

/**
 * Save project settings to ./.letta/settings.local.json
 * Creates .letta directory if it doesn't exist
 */
export async function saveProjectSettings(
  settings: ProjectSettings,
): Promise<void> {
  const settingsPath = getProjectSettingsPath();
  const dirPath = join(process.cwd(), ".letta");

  try {
    // Create .letta directory if it doesn't exist
    if (!exists(dirPath)) {
      await mkdir(dirPath, { recursive: true });
    }

    await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error("Error saving project settings:", error);
    throw error;
  }
}

/**
 * Update project settings fields
 */
export async function updateProjectSettings(
  updates: Partial<ProjectSettings>,
): Promise<ProjectSettings> {
  const currentSettings = (await loadProjectSettings()) || { lastAgent: null };
  const newSettings = { ...currentSettings, ...updates };
  await saveProjectSettings(newSettings);
  return newSettings;
}
