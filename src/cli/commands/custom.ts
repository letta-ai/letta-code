/**
 * Custom slash commands - user-defined commands from .commands/ and ~/.letta/commands/
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getStringField, parseFrontmatter } from "../../utils/frontmatter.js";

export const COMMANDS_DIR = ".commands";
export const GLOBAL_COMMANDS_DIR = join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".letta/commands",
);

export interface CustomCommand {
  id: string; // Command name without slash (e.g., "review")
  description: string; // For autocomplete display
  argumentHint?: string; // e.g., "[message]" shown after command in autocomplete
  namespace?: string; // Subdirectory name for disambiguation
  source: "project" | "user";
  path: string; // Full path to .md file
  content: string; // Prompt body (after frontmatter)
  // Future fields (parsed but not used in MVP):
  // allowedTools?: string[];
  // model?: string;
  // disableModelInvocation?: boolean;
}

// Cached commands (lazy initialized)
let cachedCommands: CustomCommand[] | null = null;

/**
 * Get custom commands (cached after first call)
 */
export async function getCustomCommands(): Promise<CustomCommand[]> {
  if (cachedCommands !== null) {
    return cachedCommands;
  }
  cachedCommands = await discoverCustomCommands();
  return cachedCommands;
}

/**
 * Force refresh of cached commands
 */
export function refreshCustomCommands(): void {
  cachedCommands = null;
}

/**
 * Discover custom commands from project and user directories
 */
export async function discoverCustomCommands(
  projectPath: string = join(process.cwd(), COMMANDS_DIR),
): Promise<CustomCommand[]> {
  const commandsById = new Map<string, CustomCommand[]>(); // Group by id for collision handling

  // 1. Discover user commands first (lower priority)
  const userCommands = await discoverFromDirectory(GLOBAL_COMMANDS_DIR, "user");
  for (const cmd of userCommands) {
    const existing = commandsById.get(cmd.id) || [];
    existing.push(cmd);
    commandsById.set(cmd.id, existing);
  }

  // 2. Discover project commands (higher priority - may override user)
  const projectCommands = await discoverFromDirectory(projectPath, "project");
  for (const cmd of projectCommands) {
    const existing = commandsById.get(cmd.id) || [];
    // Insert project commands at front (higher priority)
    existing.unshift(cmd);
    commandsById.set(cmd.id, existing);
  }

  // Flatten to array - keep all commands (for namespace disambiguation)
  // Note: When executing, we pick the first match (project > user)
  const result: CustomCommand[] = [];
  for (const [_id, cmds] of commandsById) {
    result.push(...cmds);
  }

  return result;
}

/**
 * Discover commands from a single directory
 */
async function discoverFromDirectory(
  dirPath: string,
  source: "project" | "user",
): Promise<CustomCommand[]> {
  if (!existsSync(dirPath)) {
    return [];
  }

  const commands: CustomCommand[] = [];
  await findCommandFiles(dirPath, dirPath, commands, source);
  return commands;
}

/**
 * Recursively find .md files in directory
 */
async function findCommandFiles(
  currentPath: string,
  rootPath: string,
  commands: CustomCommand[],
  source: "project" | "user",
): Promise<void> {
  try {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);

      if (entry.isDirectory()) {
        await findCommandFiles(fullPath, rootPath, commands, source);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const cmd = await parseCommandFile(fullPath, rootPath, source);
          if (cmd) {
            commands.push(cmd);
          }
        } catch (_error) {
          // Silently skip malformed command files
          // In future: could track errors in a separate array for debugging
        }
      }
    }
  } catch (_error) {
    // Directory read failed - silently continue
    // This is expected if directory doesn't exist or lacks permissions
  }
}

/**
 * Parse a command markdown file
 */
async function parseCommandFile(
  filePath: string,
  rootPath: string,
  source: "project" | "user",
): Promise<CustomCommand | null> {
  const content = await readFile(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);

  // Derive command ID from filename (without .md extension)
  const id = basename(filePath, ".md");

  // Derive namespace from subdirectory path
  const relativePath = dirname(filePath).slice(rootPath.length);
  const namespace = relativePath.replace(/^[/\\]/, "") || undefined;

  // Get description from frontmatter or first line of body
  let description = getStringField(frontmatter, "description");
  if (!description) {
    const firstLine = body.split("\n")[0]?.trim();
    description = firstLine?.replace(/^#\s*/, "") || `Custom command: ${id}`;
  }

  const argumentHint = getStringField(frontmatter, "argument-hint");

  return {
    id,
    description,
    argumentHint,
    namespace,
    source,
    path: filePath,
    content: body,
  };
}

/**
 * Substitute arguments in command content
 */
export function substituteArguments(content: string, args: string): string {
  let result = content;

  // Replace $ARGUMENTS with all arguments
  result = result.replace(/\$ARGUMENTS/g, args);

  // Replace $1, $2, ... $9 with positional arguments
  const argParts = args.split(/\s+/).filter(Boolean);
  for (let i = 0; i < 9; i++) {
    result = result.replace(new RegExp(`\\$${i + 1}`, "g"), argParts[i] || "");
  }

  return result;
}

/**
 * Expand bash commands in content
 * Replaces !`command` patterns with command output
 * Uses existing spawnCommand from Bash tool for consistency
 */
export async function expandBashCommands(content: string): Promise<string> {
  // Match !`command` pattern (backticks required)
  const bashPattern = /!`([^`]+)`/g;
  const matches = [...content.matchAll(bashPattern)];

  if (matches.length === 0) {
    return content;
  }

  // Import spawnCommand from Bash tool (same as bash mode uses)
  const { spawnCommand } = await import("../../tools/impl/Bash.js");
  const { getShellEnv } = await import("../../tools/impl/shellEnv.js");

  let result = content;

  // Execute each bash command and replace with output
  for (const match of matches) {
    const fullMatch = match[0]; // e.g., !`git status`
    const command = match[1]; // e.g., git status

    if (!command) continue; // Skip if no capture group match

    try {
      const cmdResult = await spawnCommand(command, {
        cwd: process.cwd(),
        env: getShellEnv(),
        timeout: 10000, // 10 second timeout for inline commands
      });

      const output = (cmdResult.stdout + cmdResult.stderr).trim();
      result = result.replace(fullMatch, output);
    } catch (error) {
      // On error, replace with error message
      const errMsg = error instanceof Error ? error.message : String(error);
      result = result.replace(
        fullMatch,
        `[Error executing ${command}: ${errMsg}]`,
      );
    }
  }

  return result;
}

/**
 * Find a custom command by name (handles namespace disambiguation)
 * Returns the highest priority match (project > user, then first namespace)
 */
export async function findCustomCommand(
  commandName: string, // e.g., "review" or "frontend/test"
): Promise<CustomCommand | undefined> {
  const commands = await getCustomCommands();

  // First try exact id match
  const exactMatches = commands.filter((cmd) => cmd.id === commandName);
  if (exactMatches.length > 0) {
    // Return project command if available, else user
    return exactMatches.find((c) => c.source === "project") || exactMatches[0];
  }

  return undefined;
}
