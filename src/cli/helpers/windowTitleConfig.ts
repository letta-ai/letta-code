// Config resolution and rendering for the terminal window title.
// Precedence: local project > project > global settings.

import { settingsManager } from "../../settings-manager";
import { debugLog } from "../../utils/debug";

/** All valid field keys for the window title. */
export const WINDOW_TITLE_FIELDS = [
  "agent-name",
  "conversation-name",
  "app-name",
  "version",
] as const;

export type WindowTitleField = (typeof WINDOW_TITLE_FIELDS)[number];

/** Human-readable labels and descriptions for each field. */
export const WINDOW_TITLE_FIELD_INFO: Record<
  WindowTitleField,
  { label: string; description: string }
> = {
  "agent-name": {
    label: "Agent Name",
    description: "Current agent's name",
  },
  "app-name": {
    label: "App Name",
    description: 'Application name (e.g. "Letta Code")',
  },
  version: {
    label: "Version",
    description: "Letta Code version",
  },
  "conversation-name": {
    label: "Conversation",
    description: "Current conversation title (omitted when unavailable)",
  },
};

/** Default items when no config is set. */
export const DEFAULT_WINDOW_TITLE_ITEMS: WindowTitleField[] = [
  "agent-name",
  "app-name",
];

/** Data available for rendering the window title. */
export interface WindowTitleData {
  agentName?: string | null;
  appName?: string | null;
  version: string;
  conversationSummary?: string | null;
}

/**
 * Resolve the effective window title items from all settings levels.
 * Returns the default items when no config is set.
 */
export function resolveWindowTitleConfig(
  workingDirectory: string = process.cwd(),
): WindowTitleField[] {
  try {
    // Local project settings (highest priority)
    try {
      const local =
        settingsManager.getLocalProjectSettings(workingDirectory)?.windowTitle;
      if (local?.items?.length) return local.items as WindowTitleField[];
    } catch {
      // Not loaded
    }

    // Project settings
    try {
      const project =
        settingsManager.getProjectSettings(workingDirectory)?.windowTitle;
      if (project?.items?.length) return project.items as WindowTitleField[];
    } catch {
      // Not loaded
    }

    // Global settings
    try {
      const global = settingsManager.getSettings().windowTitle;
      if (global?.items?.length) return global.items as WindowTitleField[];
    } catch {
      // Not initialized
    }

    return [...DEFAULT_WINDOW_TITLE_ITEMS];
  } catch (error) {
    debugLog(
      "windowtitle",
      "resolveWindowTitleConfig: Failed to resolve config",
      error,
    );
    return [...DEFAULT_WINDOW_TITLE_ITEMS];
  }
}

/**
 * Render the terminal window title from the selected items and available data.
 *
 * Format: `{selected items joined by | }`
 * Unavailable values are omitted. Falls back to app name if nothing resolves.
 */
export function renderWindowTitle(
  items: WindowTitleField[],
  data: WindowTitleData,
): string {
  // Sort items to canonical field order before rendering
  const ordered = items.slice().sort((a, b) => {
    const aIdx = WINDOW_TITLE_FIELDS.indexOf(a);
    const bIdx = WINDOW_TITLE_FIELDS.indexOf(b);
    return aIdx - bIdx;
  });

  const segments: string[] = [];

  for (const key of ordered) {
    const value = resolveFieldValue(key, data);
    if (value !== null) {
      segments.push(value);
    }
  }

  if (segments.length === 0) {
    return data.appName || "Letta Code";
  }

  return segments.join(" | ");
}

function resolveFieldValue(
  key: WindowTitleField,
  data: WindowTitleData,
): string | null {
  switch (key) {
    case "agent-name":
      return data.agentName || null;
    case "app-name":
      return data.appName || null;
    case "version":
      return data.version;
    case "conversation-name":
      return data.conversationSummary || null;
    default:
      return null;
  }
}
