/**
 * Shell alias expansion for bash mode.
 * Reads aliases from common shell config files and expands them in commands.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Cache of parsed aliases
let aliasCache: Map<string, string> | null = null;

/**
 * Common shell config files that may contain aliases
 */
const ALIAS_FILES = [
  ".zshrc",
  ".bashrc",
  ".bash_aliases",
  ".zsh_aliases",
  ".aliases",
  ".shell_aliases",
];

/**
 * Parse alias and function definitions from a shell config file.
 * Handles formats like:
 *   alias gco='git checkout'
 *   alias gco="git checkout"
 *   function_name() { ... }
 */
function parseAliasesFromFile(filePath: string): Map<string, string> {
  const aliases = new Map<string, string>();

  if (!existsSync(filePath)) {
    return aliases;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    let inFunction = false;
    let functionName = "";
    let functionBody = "";
    let braceDepth = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      // Track function body parsing
      if (inFunction) {
        functionBody += `${line}\n`;
        braceDepth += (line.match(/{/g) || []).length;
        braceDepth -= (line.match(/}/g) || []).length;

        if (braceDepth === 0) {
          // Function complete - store it
          // Functions are stored with a special marker so we know to source them
          aliases.set(functionName, `__LETTA_FUNC__${functionBody}`);
          inFunction = false;
          functionName = "";
          functionBody = "";
        }
        continue;
      }

      // Skip comments and empty lines
      if (trimmed.startsWith("#") || !trimmed) {
        continue;
      }

      // Match function definitions: name() { or function name {
      const funcMatch =
        trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\)\s*\{?/) ||
        trimmed.match(/^function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\{?/);
      if (funcMatch?.[1]) {
        functionName = funcMatch[1];
        functionBody = `${line}\n`;
        braceDepth =
          (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;

        if (braceDepth > 0) {
          inFunction = true;
        } else if (
          braceDepth === 0 &&
          line.includes("{") &&
          line.includes("}")
        ) {
          // One-liner function
          aliases.set(functionName, `__LETTA_FUNC__${functionBody}`);
          functionName = "";
          functionBody = "";
        }
        continue;
      }

      // Match alias definitions: alias name='value' or alias name="value" or alias name=value
      const aliasMatch = trimmed.match(/^alias\s+([a-zA-Z0-9_-]+)=(.+)$/);
      if (aliasMatch) {
        const [, name, rawValue] = aliasMatch;
        if (!name || !rawValue) continue;
        let value = rawValue.trim();

        // Remove surrounding quotes if present
        if (
          (value.startsWith("'") && value.endsWith("'")) ||
          (value.startsWith('"') && value.endsWith('"'))
        ) {
          value = value.slice(1, -1);
        }

        // Unescape basic escapes
        value = value.replace(/\\'/g, "'").replace(/\\"/g, '"');

        if (name && value) {
          aliases.set(name, value);
        }
      }
    }
  } catch (_error) {
    // Silently ignore read errors
  }

  return aliases;
}

/**
 * Load all aliases from common shell config files.
 * Results are cached for performance.
 */
export function loadAliases(forceReload = false): Map<string, string> {
  if (aliasCache && !forceReload) {
    return aliasCache;
  }

  const home = homedir();
  const allAliases = new Map<string, string>();

  for (const file of ALIAS_FILES) {
    const filePath = join(home, file);
    const fileAliases = parseAliasesFromFile(filePath);

    // Later files override earlier ones
    for (const [name, value] of fileAliases) {
      allAliases.set(name, value);
    }
  }

  aliasCache = allAliases;
  return allAliases;
}

/**
 * Result of alias expansion
 */
export interface ExpandedCommand {
  /** The expanded command to run */
  command: string;
  /** If the command uses a function, this contains the function definition to prepend */
  functionDef?: string;
}

/**
 * Expand aliases in a command.
 * Only expands the first word if it's an alias.
 * Handles recursive alias expansion (up to a limit).
 * For functions, returns the function definition to prepend to the command.
 */
export function expandAliases(command: string, maxDepth = 10): ExpandedCommand {
  const aliases = loadAliases();

  if (aliases.size === 0) {
    return { command };
  }

  const trimmed = command.trim();
  const firstSpaceIdx = trimmed.indexOf(" ");
  const firstWord =
    firstSpaceIdx === -1 ? trimmed : trimmed.slice(0, firstSpaceIdx);
  const rest = firstSpaceIdx === -1 ? "" : trimmed.slice(firstSpaceIdx);

  const aliasValue = aliases.get(firstWord);

  // Check if it's a function
  if (aliasValue?.startsWith("__LETTA_FUNC__")) {
    const functionDef = aliasValue.slice("__LETTA_FUNC__".length);
    // Return the original command but with function def to prepend
    return { command, functionDef };
  }

  // Regular alias expansion
  if (!aliasValue) {
    return { command };
  }

  let expanded = aliasValue + rest;
  let depth = 1;

  // Continue expanding if the result starts with another alias
  while (depth < maxDepth) {
    const expandedTrimmed = expanded.trim();
    const expandedFirstSpace = expandedTrimmed.indexOf(" ");
    const expandedFirstWord =
      expandedFirstSpace === -1
        ? expandedTrimmed
        : expandedTrimmed.slice(0, expandedFirstSpace);
    const expandedRest =
      expandedFirstSpace === -1
        ? ""
        : expandedTrimmed.slice(expandedFirstSpace);

    const nextAlias = aliases.get(expandedFirstWord);
    if (!nextAlias || nextAlias.startsWith("__LETTA_FUNC__")) {
      break;
    }

    expanded = nextAlias + expandedRest;
    depth++;
  }

  return { command: expanded };
}

/**
 * Clear the alias cache (useful for testing or when config files change)
 */
export function clearAliasCache(): void {
  aliasCache = null;
}
