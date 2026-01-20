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
 * Parse alias definitions from a shell config file.
 * Handles formats like:
 *   alias gco='git checkout'
 *   alias gco="git checkout"
 *   alias gco=git\ checkout
 */
function parseAliasesFromFile(filePath: string): Map<string, string> {
  const aliases = new Map<string, string>();
  
  if (!existsSync(filePath)) {
    return aliases;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip comments and empty lines
      if (trimmed.startsWith("#") || !trimmed) {
        continue;
      }

      // Match alias definitions: alias name='value' or alias name="value" or alias name=value
      const aliasMatch = trimmed.match(/^alias\s+([a-zA-Z0-9_-]+)=(.+)$/);
      if (aliasMatch) {
        const [, name, rawValue] = aliasMatch;
        let value = rawValue.trim();

        // Remove surrounding quotes if present
        if ((value.startsWith("'") && value.endsWith("'")) ||
            (value.startsWith('"') && value.endsWith('"'))) {
          value = value.slice(1, -1);
        }

        // Unescape basic escapes
        value = value.replace(/\\'/g, "'").replace(/\\"/g, '"');

        if (name && value) {
          aliases.set(name, value);
        }
      }
    }
  } catch (error) {
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
 * Expand aliases in a command.
 * Only expands the first word if it's an alias.
 * Handles recursive alias expansion (up to a limit).
 */
export function expandAliases(command: string, maxDepth = 10): string {
  const aliases = loadAliases();
  
  if (aliases.size === 0) {
    return command;
  }

  let expanded = command;
  let depth = 0;

  while (depth < maxDepth) {
    const trimmed = expanded.trim();
    const firstSpaceIdx = trimmed.indexOf(" ");
    const firstWord = firstSpaceIdx === -1 ? trimmed : trimmed.slice(0, firstSpaceIdx);
    const rest = firstSpaceIdx === -1 ? "" : trimmed.slice(firstSpaceIdx);

    const aliasValue = aliases.get(firstWord);
    if (!aliasValue) {
      break;
    }

    // Expand the alias
    expanded = aliasValue + rest;
    depth++;
  }

  return expanded;
}

/**
 * Clear the alias cache (useful for testing or when config files change)
 */
export function clearAliasCache(): void {
  aliasCache = null;
}
