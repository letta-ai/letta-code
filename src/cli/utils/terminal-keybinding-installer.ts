
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

export function detectTerminalType(): TerminalType {
  // Check for Cursor first (it sets TERM_PROGRAM=vscode for compatibility)
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_CHANNEL) {
    return "cursor";
  }

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

const SHIFT_ENTER_KEYBINDING: VSCodeKeybinding = {
  key: "shift+enter",
  command: "workbench.action.terminal.sendSequence",
  args: { text: "\u001b\r" },
  when: "terminalFocus",
};

function stripJsonComments(jsonc: string): string {
  let result = jsonc.replace(/\/\/.*$/gm, "");

  result = result.replace(/\/\*[\s\S]*?\*\//g, "");

  result = result.replace(/,(\s*[}\]])/g, "$1");

  return result;
}

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

function createBackup(keybindingsPath: string): string | null {
  if (!existsSync(keybindingsPath)) return null;

  const backupPath = `${keybindingsPath}.letta-backup`;
  try {
    copyFileSync(keybindingsPath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

export interface InstallResult {
  success: boolean;
  error?: string;
  backupPath?: string;
  alreadyExists?: boolean;
}

export function installKeybinding(keybindingsPath: string): InstallResult {
  try {
    if (keybindingExists(keybindingsPath)) {
      return { success: true, alreadyExists: true };
    }

    const parentDir = dirname(keybindingsPath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    let keybindings: VSCodeKeybinding[] = [];
    let backupPath: string | null = null;

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

    keybindings.push(SHIFT_ENTER_KEYBINDING);

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

    const filtered = keybindings.filter(
      (kb) =>
        !(
          kb.key?.toLowerCase() === "shift+enter" &&
          kb.command === "workbench.action.terminal.sendSequence" &&
          kb.when?.includes("terminalFocus")
        ),
    );

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

// WezTerm has a bug where Delete key sends 0x08 (backspace) instead of ESC[3~
// when kitty keyboard protocol is enabled. This keybinding fixes it.
// WezTerm auto-reloads config, so the fix takes effect immediately.
// See: https://github.com/wez/wezterm/issues/3758

export function isWezTerm(): boolean {
  return process.env.TERM_PROGRAM === "WezTerm";
}

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

  return join(homedir(), ".wezterm.lua");
}

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

const RETURN_CONFIG_LINE = /^\s*return\s+config\s*$/;
const RETURN_TABLE_LINE = /^\s*return\s*\{/;
const LOCAL_CONFIG_LINE = /^\s*local\s+config\b/;

interface LuaCodeLine {
  start: number;
  end: number;
  line: string;
  lineEnding: string;
  code: string;
}

function stripLuaCommentsFromLine(
  line: string,
  blockCommentEnd: string | null,
): { code: string; blockCommentEnd: string | null } {
  let code = "";
  let index = 0;
  let currentBlockCommentEnd = blockCommentEnd;

  while (index < line.length) {
    if (currentBlockCommentEnd) {
      const closeIndex = line.indexOf(currentBlockCommentEnd, index);
      if (closeIndex === -1) {
        return { code, blockCommentEnd: currentBlockCommentEnd };
      }

      index = closeIndex + currentBlockCommentEnd.length;
      currentBlockCommentEnd = null;
      continue;
    }

    if (line.startsWith("--", index)) {
      const longCommentMatch = line.slice(index).match(/^--\[(=*)\[/);
      if (longCommentMatch) {
        const equals = longCommentMatch[1] ?? "";
        currentBlockCommentEnd = `]${equals}]`;
        index += longCommentMatch[0].length;
        continue;
      }

      break;
    }

    code += line.charAt(index);
    index += 1;
  }

  return { code, blockCommentEnd: currentBlockCommentEnd };
}

function getLuaCodeLines(content: string): LuaCodeLine[] {
  const lines: LuaCodeLine[] = [];
  let start = 0;
  let blockCommentEnd: string | null = null;

  while (start < content.length) {
    const newlineIndex = content.indexOf("\n", start);
    const end = newlineIndex === -1 ? content.length : newlineIndex + 1;
    const rawLine = content.slice(start, end);
    const lineEnding = rawLine.endsWith("\r\n")
      ? "\r\n"
      : rawLine.endsWith("\n")
        ? "\n"
        : "";
    const line = lineEnding
      ? rawLine.slice(0, rawLine.length - lineEnding.length)
      : rawLine;
    const stripped = stripLuaCommentsFromLine(line, blockCommentEnd);
    blockCommentEnd = stripped.blockCommentEnd;

    lines.push({
      start,
      end,
      line,
      lineEnding,
      code: stripped.code,
    });

    start = end;
  }

  return lines;
}

function findLastMatchingLuaLine(
  content: string,
  pattern: RegExp,
): LuaCodeLine | null {
  let result: LuaCodeLine | null = null;

  for (const line of getLuaCodeLines(content)) {
    if (pattern.test(line.code)) {
      result = line;
    }
  }

  return result;
}

function hasMatchingLuaLine(content: string, pattern: RegExp): boolean {
  return findLastMatchingLuaLine(content, pattern) !== null;
}

function replaceLuaLine(
  content: string,
  line: LuaCodeLine,
  replacement: string,
): string {
  return `${content.slice(0, line.start)}${replacement}${line.lineEnding}${content.slice(line.end)}`;
}

export function injectWezTermDeleteFix(content: string): string {
  let nextContent = content;

  // For simple configs that return a table directly, we need to modify them
  // to use a config variable. Check if it's a simple "return {" style config.
  const returnTableLine = findLastMatchingLuaLine(
    nextContent,
    RETURN_TABLE_LINE,
  );
  if (returnTableLine && !hasMatchingLuaLine(nextContent, LOCAL_CONFIG_LINE)) {
    nextContent = replaceLuaLine(
      nextContent,
      returnTableLine,
      returnTableLine.line.replace(/return\s*\{/, "local config = {"),
    );
    if (!hasMatchingLuaLine(nextContent, RETURN_CONFIG_LINE)) {
      nextContent = `${nextContent.trimEnd()}\n\nreturn config\n`;
    }
  }

  if (!nextContent.trim()) {
    nextContent = `-- WezTerm configuration
local config = {}

return config
`;
  }

  const returnConfigLine = findLastMatchingLuaLine(
    nextContent,
    RETURN_CONFIG_LINE,
  );
  if (returnConfigLine) {
    return `${nextContent.slice(0, returnConfigLine.start)}${WEZTERM_DELETE_FIX}\n${nextContent.slice(returnConfigLine.start)}`;
  }

  return `${nextContent.trimEnd()}\n${WEZTERM_DELETE_FIX}\n`;
}

export function wezTermDeleteFixExists(configPath: string): boolean {
  if (!existsSync(configPath)) return false;

  try {
    const content = readFileSync(configPath, { encoding: "utf-8" });
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

export function installWezTermDeleteFix(): InstallResult {
  const configPath = getWezTermConfigPath();

  try {
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

    content = injectWezTermDeleteFix(content);

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
