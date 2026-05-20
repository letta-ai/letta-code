import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const LETTA_SETTINGS_PATH = join(homedir(), ".letta", ".lettasettings");

/**
 * Default contents written to ~/.letta/.lettasettings on first run.
 * Each setting is documented inline so users know what they can adjust.
 */
const DEFAULT_SETTINGS = `\
# ~/.letta/.lettasettings — Letta Code user settings
#
# This file is read by Letta Code at startup.
# Syntax: KEY=VALUE (one per line). Lines starting with # are comments.
# Changes take effect on the next session (restart required).

# ─── File Search ─────────────────────────────────────────────────────────────

# MAX_ENTRIES
# Maximum number of file entries kept in the in-memory @ file search cache.
# Files beyond this limit are still discoverable via the disk-scan fallback —
# they just won't appear in autocomplete results until searched for directly.
#
# Raise this for large monorepos where you want more files instantly available.
# Lower it if Letta Code is using too much memory on a constrained machine.
#
# Default: 50000
MAX_ENTRIES=50000
`;

/**
 * Parse a .lettasettings file into a key→value map.
 * - Lines starting with # are comments and are ignored.
 * - Empty lines are ignored.
 * - Values are the raw string after the first '='; no quote stripping.
 */
function parseSettings(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Read ~/.letta/.lettasettings, creating it with defaults if it doesn't exist.
 * Returns a key→value map of all settings. Safe to call multiple times.
 */
export function readLettaSettings(): Record<string, string> {
  if (!existsSync(LETTA_SETTINGS_PATH)) {
    try {
      mkdirSync(dirname(LETTA_SETTINGS_PATH), { recursive: true });
      writeFileSync(LETTA_SETTINGS_PATH, DEFAULT_SETTINGS, "utf-8");
    } catch {
      // Read-only filesystem or permission error — fall back to built-in defaults.
    }
  }

  try {
    const content = readFileSync(LETTA_SETTINGS_PATH, "utf-8");
    return parseSettings(content);
  } catch {
    return {};
  }
}

/**
 * Read a single integer setting from ~/.letta/.lettasettings.
 * Returns `defaultValue` if the key is missing, unparseable, or non-positive.
 */
export function readIntSetting(key: string, defaultValue: number): number {
  const settings = readLettaSettings();
  const raw = settings[key];
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}
