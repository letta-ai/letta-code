/**
 * Terminal keybinding installer for VS Code/Cursor/Windsurf
 * Installs Shift+Enter keybinding that sends ESC+CR for multi-line input
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export type TerminalType = "vscode" | "cursor" | "windsurf" | null;

interface VSCodeKeybinding {
  key: string;
  command: string;
  args?: Record<string, unknown>;
  when?: string;
}

/**
 * Detect terminal type from environment variables
 */
export function detectTerminalType(): TerminalType {
  // Check for Cursor first (it sets TERM_PROGRAM=vscode for compatibility)
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_CHANNEL) {
    return "cursor";
  }

  // Check for Windsurf
  if (process.env.WINDSURF_TRACE_ID || process.env.WINDSURF_CHANNEL) {
    return "windsurf";
  }

  const termProgram = process.env.TERM_PROGRAM?.toLowerCase();

  if (termProgram === "vscode") return "vscode";
  if (termProgram === "cursor") return "cursor";
  if (termProgram === "windsurf") return "windsurf";

  // Fallback checks
  if (process.env.VSCODE_INJECTION === "1") return "vscode";

  return null;
}

/**
 * Check if running in a VS Code-like terminal (xterm.js-based)
 */
export function isVSCodeLikeTerminal(): boolean {
  return detectTerminalType() !== null;
}

/**
 * Get platform-specific path to keybindings.json
 */
export function getKeybindingsPath(terminal: TerminalType): string | null {
  if (!terminal) return null;

  const appName = {
    vscode: "Code",
    cursor: "Cursor",
    windsurf: "Windsurf",
  }[terminal];

  const os = platform();

  if (os === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      appName,
      "User",
      "keybindings.json",
    );
  }

  if (os === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) return null;
    return join(appData, appName, "User", "keybindings.json");
  }

  if (os === "linux") {
    return join(homedir(), ".config", appName, "User", "keybindings.json");
  }

  return null;
}

/**
 * The keybinding we install - Shift+Enter sends ESC+CR
 */
const SHIFT_ENTER_KEYBINDING: VSCodeKeybinding = {
  key: "shift+enter",
  command: "workbench.action.terminal.sendSequence",
  args: { text: "\u001b\r" },
  when: "terminalFocus",
};

/**
 * Strip single-line and multi-line comments from JSONC
 * Also handles trailing commas
 */
function stripJsonComments(jsonc: string): string {
  // Remove single-line comments (// ...)
  let result = jsonc.replace(/\/\/.*$/gm, "");

  // Remove multi-line comments (/* ... */)
  result = result.replace(/\/\*[\s\S]*?\*\//g, "");

  // Remove trailing commas before ] or }
  result = result.replace(/,(\s*[}\]])/g, "$1");

  return result;
}

/**
 * Parse keybindings.json (handles JSONC with comments)
 */
function parseKeybindings(content: string): VSCodeKeybinding[] | null {
  try {
    const stripped = stripJsonComments(content);
    const parsed = JSON.parse(stripped);
    if (!Array.isArray(parsed)) return null;
    return parsed as VSCodeKeybinding[];
  } catch {
    return null;
  }
}

/**
 * Check if our Shift+Enter keybinding already exists
 */
export function keybindingExists(keybindingsPath: string): boolean {
  if (!existsSync(keybindingsPath)) return false;

  try {
    const content = readFileSync(keybindingsPath, { encoding: "utf-8" });
    const keybindings = parseKeybindings(content);

    if (!keybindings) return false;

    return keybindings.some(
      (kb) =>
        kb.key?.toLowerCase() === "shift+enter" &&
        kb.command === "workbench.action.terminal.sendSequence" &&
        kb.when?.includes("terminalFocus"),
    );
  } catch {
    return false;
  }
}

/**
 * Create backup of keybindings.json
 */
function createBackup(keybindingsPath: string): string | null {
  if (!existsSync(keybindingsPath)) return null;

  const backupPath = `${keybindingsPath}.letta-backup`;
  try {
    copyFileSync(keybindingsPath, backupPath);
    return backupPath;
  } catch {
    // Backup failed, but we can continue without it
    return null;
  }
}

export interface InstallResult {
  success: boolean;
  error?: string;
  backupPath?: string;
  alreadyExists?: boolean;
}

/**
 * Install the Shift+Enter keybinding
 */
export function installKeybinding(keybindingsPath: string): InstallResult {
  try {
    // Check if already exists
    if (keybindingExists(keybindingsPath)) {
      return { success: true, alreadyExists: true };
    }

    // Ensure parent directory exists
    const parentDir = dirname(keybindingsPath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    let keybindings: VSCodeKeybinding[] = [];
    let backupPath: string | null = null;

    // Read existing keybindings if file exists
    if (existsSync(keybindingsPath)) {
      backupPath = createBackup(keybindingsPath);

      const content = readFileSync(keybindingsPath, { encoding: "utf-8" });
      const parsed = parseKeybindings(content);

      if (parsed === null) {
        return {
          success: false,
          error: `Could not parse ${keybindingsPath}. Please fix syntax errors and try again.`,
        };
      }

      keybindings = parsed;
    }

    // Add our keybinding
    keybindings.push(SHIFT_ENTER_KEYBINDING);

    // Write back
    const newContent = `${JSON.stringify(keybindings, null, 2)}\n`;
    writeFileSync(keybindingsPath, newContent, { encoding: "utf-8" });

    return {
      success: true,
      backupPath: backupPath ?? undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to install keybinding: ${message}`,
    };
  }
}

/**
 * Remove the Shift+Enter keybinding we installed
 */
export function removeKeybinding(keybindingsPath: string): InstallResult {
  try {
    if (!existsSync(keybindingsPath)) {
      return { success: true }; // Nothing to remove
    }

    const content = readFileSync(keybindingsPath, { encoding: "utf-8" });
    const keybindings = parseKeybindings(content);

    if (!keybindings) {
      return {
        success: false,
        error: `Could not parse ${keybindingsPath}`,
      };
    }

    // Filter out our keybinding
    const filtered = keybindings.filter(
      (kb) =>
        !(
          kb.key?.toLowerCase() === "shift+enter" &&
          kb.command === "workbench.action.terminal.sendSequence" &&
          kb.when?.includes("terminalFocus")
        ),
    );

    // Write back
    const newContent = `${JSON.stringify(filtered, null, 2)}\n`;
    writeFileSync(keybindingsPath, newContent, { encoding: "utf-8" });

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to remove keybinding: ${message}`,
    };
  }
}

/**
 * Convenience function to install keybinding for current terminal
 */
export function installKeybindingForCurrentTerminal(): InstallResult {
  const terminal = detectTerminalType();
  if (!terminal) {
    return {
      success: false,
      error: "Not running in a VS Code-like terminal",
    };
  }

  const path = getKeybindingsPath(terminal);
  if (!path) {
    return {
      success: false,
      error: `Could not determine keybindings.json path for ${terminal}`,
    };
  }

  return installKeybinding(path);
}

/**
 * Convenience function to remove keybinding for current terminal
 */
export function removeKeybindingForCurrentTerminal(): InstallResult {
  const terminal = detectTerminalType();
  if (!terminal) {
    return {
      success: false,
      error: "Not running in a VS Code-like terminal",
    };
  }

  const path = getKeybindingsPath(terminal);
  if (!path) {
    return {
      success: false,
      error: `Could not determine keybindings.json path for ${terminal}`,
    };
  }

  return removeKeybinding(path);
}

// ============================================================================
// WezTerm keybinding support
// WezTerm has a bug where Delete key sends 0x08 (backspace) instead of ESC[3~
// when kitty keyboard protocol is enabled. This keybinding fixes it.
// WezTerm auto-reloads config, so the fix takes effect immediately.
// See: https://github.com/wez/wezterm/issues/3758
// ============================================================================

/**
 * Check if running in WezTerm
 */
export function isWezTerm(): boolean {
  return process.env.TERM_PROGRAM === "WezTerm";
}

/**
 * Get WezTerm config path
 */
export function getWezTermConfigPath(): string {
  // WezTerm looks for config in these locations (in order):
  // 1. $WEZTERM_CONFIG_FILE
  // 2. $XDG_CONFIG_HOME/wezterm/wezterm.lua
  // 3. ~/.config/wezterm/wezterm.lua
  // 4. ~/.wezterm.lua
  if (process.env.WEZTERM_CONFIG_FILE) {
    return process.env.WEZTERM_CONFIG_FILE;
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) {
    const xdgPath = join(xdgConfig, "wezterm", "wezterm.lua");
    if (existsSync(xdgPath)) return xdgPath;
  }

  const configPath = join(homedir(), ".config", "wezterm", "wezterm.lua");
  if (existsSync(configPath)) return configPath;

  // Default to ~/.wezterm.lua
  return join(homedir(), ".wezterm.lua");
}

/**
 * The Lua code to fix Delete key in WezTerm
 */
const WEZTERM_DELETE_FIX = `
-- Letta Code: Fix Delete key sending wrong sequence with kitty keyboard protocol
-- See: https://github.com/wez/wezterm/issues/3758
local wezterm = require 'wezterm'
local keys = config.keys or {}
table.insert(keys, {
  key = 'Delete',
  mods = 'NONE',
  action = wezterm.action.SendString '\\x1b[3~',
})
config.keys = keys
`;

/**
 * Check if WezTerm config already has our Delete key fix
 */
export function wezTermDeleteFixExists(configPath: string): boolean {
  if (!existsSync(configPath)) return false;

  try {
    const content = readFileSync(configPath, { encoding: "utf-8" });
    // Check if our fix or equivalent already exists
    return (
      content.includes("Letta Code: Fix Delete key") ||
      (content.includes("key = 'Delete'") &&
        content.includes("SendString") &&
        content.includes("\\x1b[3~"))
    );
  } catch {
    return false;
  }
}

/**
 * Install WezTerm Delete key fix
 */
export function installWezTermDeleteFix(): InstallResult {
  const configPath = getWezTermConfigPath();

  try {
    // Check if already installed
    if (wezTermDeleteFixExists(configPath)) {
      return { success: true, alreadyExists: true };
    }

    let content = "";
    let backupPath: string | null = null;

    if (existsSync(configPath)) {
      backupPath = `${configPath}.letta-backup`;
      copyFileSync(configPath, backupPath);
      content = readFileSync(configPath, { encoding: "utf-8" });
    }

    // For simple configs that return a table directly, we need to modify them
    // to use a config variable. Check if it's a simple "return {" style config.
    if (content.includes("return {") && !content.includes("local config")) {
      // Convert simple config to use config variable
      content = content.replace(/return\s*\{/, "local config = {");
      // Add return config at the end if not present
      if (!content.includes("return config")) {
        content = `${content.trimEnd()}\n\nreturn config\n`;
      }
    }

    // If config doesn't exist or is empty, create a basic one
    if (!content.trim()) {
      content = `-- WezTerm configuration
local config = {}

return config
`;
    }

    // Insert our fix before "return config"
    if (content.includes("return config")) {
      content = content.replace(
        "return config",
        `${WEZTERM_DELETE_FIX}\nreturn config`,
      );
    } else {
      // Append to end as fallback
      content = `${content.trimEnd()}\n${WEZTERM_DELETE_FIX}\n`;
    }

    // Ensure parent directory exists
    const parentDir = dirname(configPath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    writeFileSync(configPath, content, { encoding: "utf-8" });

    return {
      success: true,
      backupPath: backupPath ?? undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to install WezTerm Delete key fix: ${message}`,
    };
  }
}
