// src/settings.ts
// Manages user settings stored in ~/.letta/settings.json

import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionRules } from "./permissions/types";
import { exists, readFile, writeFile } from "./utils/fs.js";

export type UIMode = "simple" | "rich";

export interface Settings {
  uiMode: UIMode;
  lastAgent: string | null;
  tokenStreaming: boolean;
  globalSharedBlockIds: Record<string, string>; // label -> blockId mapping (persona, human; style moved to project settings)
  permissions?: PermissionRules;
  env?: Record<string, string>;
}

const DEFAULT_SETTINGS: Settings = {
  uiMode: "simple",
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
