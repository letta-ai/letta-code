// src/permissions/matcher.ts
// Pattern matching logic for permission rules

import { resolve } from "node:path";
import { minimatch } from "minimatch";

/**
 * Check if a file path matches a permission pattern.
 *
 * Patterns follow Claude Code's glob syntax:
 * - "Read(file.txt)" - exact match in working directory
 * - "Read(*.txt)" - glob pattern
 * - "Read(src/**)" - recursive glob
 * - "Read(//absolute/path/**)" - absolute path pattern
 * - "Read(~/.zshrc)" - tilde expansion
 *
 * @param query - The query to check (e.g., "Read(.env)")
 * @param pattern - The permission pattern (e.g., "Read(src/**)")
 * @param workingDirectory - Current working directory
 */
export function matchesFilePattern(
  query: string,
  pattern: string,
  workingDirectory: string,
): boolean {
  // Extract tool name and file path from query
  // Format: "ToolName(filePath)"
  const queryMatch = query.match(/^([^(]+)\((.+)\)$/);
  if (!queryMatch || !queryMatch[1] || !queryMatch[2]) {
    return false;
  }
  const queryTool = queryMatch[1];
  const filePath = queryMatch[2];

  // Extract tool name and glob pattern from permission rule
  // Format: "ToolName(pattern)"
  const patternMatch = pattern.match(/^([^(]+)\((.+)\)$/);
  if (!patternMatch || !patternMatch[1] || !patternMatch[2]) {
    return false;
  }
  const patternTool = patternMatch[1];
  let globPattern = patternMatch[2];

  // Tool names must match
  if (queryTool !== patternTool) {
    return false;
  }

  // Normalize ./ prefix
  if (globPattern.startsWith("./")) {
    globPattern = globPattern.slice(2);
  }

  // Handle tilde expansion
  if (globPattern.startsWith("~/")) {
    const homedir = require("node:os").homedir();
    globPattern = globPattern.replace(/^~/, homedir);
  }

  // Handle absolute paths (Claude Code uses // prefix)
  if (globPattern.startsWith("//")) {
    globPattern = globPattern.slice(1); // Remove one slash to make it absolute
  }

  // Resolve file path to absolute
  const absoluteFilePath = resolve(workingDirectory, filePath);

  // If pattern is absolute, compare directly
  if (globPattern.startsWith("/")) {
    return minimatch(absoluteFilePath, globPattern);
  }

  // If pattern is relative, compare against both:
  // 1. Relative path from working directory
  // 2. Absolute path (for patterns that might match absolute paths)
  const relativeFilePath = filePath.startsWith("/")
    ? absoluteFilePath.replace(`${workingDirectory}/`, "")
    : filePath;

  return (
    minimatch(relativeFilePath, globPattern) ||
    minimatch(absoluteFilePath, globPattern)
  );
}

/**
 * Check if a bash command matches a permission pattern.
 *
 * Bash patterns use PREFIX matching, not regex:
 * - "Bash(git diff:*)" matches "Bash(git diff ...)", "Bash(git diff HEAD)", etc.
 * - "Bash(npm run lint)" matches exactly "Bash(npm run lint)"
 * - The :* syntax is a special wildcard for "this command and any args"
 *
 * @param query - The bash query to check (e.g., "Bash(git diff HEAD)")
 * @param pattern - The permission pattern (e.g., "Bash(git diff:*)")
 */
/**
 * Extract the "actual" command from a compound command by stripping cd prefixes.
 * e.g., "cd /path && bun run check" → "bun run check"
 */
function extractActualCommand(command: string): string {
  // If command contains &&, |, or ;, split and find the actual command (skip cd)
  if (
    command.includes("&&") ||
    command.includes("|") ||
    command.includes(";")
  ) {
    const segments = command.split(/\s*(?:&&|\||;)\s*/);
    for (const segment of segments) {
      const trimmed = segment.trim();
      const firstToken = trimmed.split(/\s+/)[0];
      // Skip cd commands - we want the actual command
      if (firstToken !== "cd") {
        return trimmed;
      }
    }
  }
  return command;
}

export function matchesBashPattern(query: string, pattern: string): boolean {
  // Extract the command from query
  // Format: "Bash(actual command)" or "Bash()"
  const queryMatch = query.match(/^Bash\((.*)\)$/);
  if (!queryMatch || queryMatch[1] === undefined) {
    return false;
  }
  const rawCommand = queryMatch[1];
  // Extract actual command by stripping cd prefixes from compound commands
  const command = extractActualCommand(rawCommand);

  // Extract the command pattern from permission rule
  // Format: "Bash(command pattern)" or "Bash()"
  const patternMatch = pattern.match(/^Bash\((.*)\)$/);
  if (!patternMatch || patternMatch[1] === undefined) {
    return false;
  }
  const commandPattern = patternMatch[1];

  // Check for wildcard suffix
  if (commandPattern.endsWith(":*")) {
    // Prefix match: command must start with pattern (minus :*)
    const prefix = commandPattern.slice(0, -2);
    // Try matching against both raw and extracted command
    return command.startsWith(prefix) || rawCommand.startsWith(prefix);
  }

  // Exact match (try both raw and extracted)
  return command === commandPattern || rawCommand === commandPattern;
}

/**
 * Check if a tool name matches a permission pattern.
 *
 * For non-file tools, we match by tool name:
 * - "WebFetch" matches all WebFetch calls
 * - "*" matches all tools
 *
 * @param toolName - The tool name
 * @param pattern - The permission pattern
 */
export function matchesToolPattern(toolName: string, pattern: string): boolean {
  // Wildcard matches everything
  if (pattern === "*") {
    return true;
  }

  // Check for tool name match (with or without parens)
  if (pattern === toolName || pattern === `${toolName}()`) {
    return true;
  }

  // Check for tool name prefix (e.g., "WebFetch(...)")
  if (pattern.startsWith(`${toolName}(`)) {
    return true;
  }

  return false;
}
