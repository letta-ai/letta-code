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
