// src/project-settings.ts
// Manages project-level settings stored in ./.letta/settings.json

import { join } from "node:path";

export interface ProjectSettings {
  localSharedBlockIds: Record<string, string>; // label -> blockId mapping for project-local blocks
}

const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  localSharedBlockIds: {},
};

type RawProjectSettings = {
  localSharedBlockIds?: Record<string, string>;
  [key: string]: unknown;
};

function getProjectSettingsPath(workingDirectory: string): string {
  return join(workingDirectory, ".letta", "settings.json");
}

/**
 * Load project settings from ./.letta/settings.json
 * If the file doesn't exist or doesn't have localSharedBlockIds, returns defaults
 */
export async function loadProjectSettings(
  workingDirectory: string = process.cwd(),
): Promise<ProjectSettings> {
  const settingsPath = getProjectSettingsPath(workingDirectory);
  const file = Bun.file(settingsPath);

  try {
    if (!(await file.exists())) {
      return DEFAULT_PROJECT_SETTINGS;
    }

    const settings = (await file.json()) as RawProjectSettings;

    // Extract only localSharedBlockIds (permissions and other fields handled elsewhere)
    return {
      localSharedBlockIds: settings.localSharedBlockIds ?? {},
    };
  } catch (error) {
    console.error("Error loading project settings, using defaults:", error);
    return DEFAULT_PROJECT_SETTINGS;
  }
}

/**
 * Save project settings to ./.letta/settings.json
 * Merges with existing settings (like permissions) instead of overwriting
 */
export async function saveProjectSettings(
  workingDirectory: string,
  updates: Partial<ProjectSettings>,
): Promise<void> {
  const settingsPath = getProjectSettingsPath(workingDirectory);
  const file = Bun.file(settingsPath);

  try {
    // Read existing settings (might have permissions, etc.)
    let existingSettings: RawProjectSettings = {};
    if (await file.exists()) {
      existingSettings = (await file.json()) as RawProjectSettings;
    }

    // Merge updates with existing settings
    const newSettings: RawProjectSettings = {
      ...existingSettings,
      ...updates,
    };

    // Bun.write automatically creates parent directories (.letta/)
    await Bun.write(settingsPath, JSON.stringify(newSettings, null, 2));
  } catch (error) {
    console.error("Error saving project settings:", error);
    throw error;
  }
}

/**
 * Update specific project settings fields
 */
export async function updateProjectSettings(
  workingDirectory: string,
  updates: Partial<ProjectSettings>,
): Promise<ProjectSettings> {
  await saveProjectSettings(workingDirectory, updates);
  return loadProjectSettings(workingDirectory);
}
