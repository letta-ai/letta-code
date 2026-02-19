// src/permissions/matcher.ts
// Pattern matching logic for permission rules

import { resolve } from "node:path";
import { minimatch } from "minimatch";
import { canonicalToolName } from "./canonical";

export interface MatcherOptions {
  canonicalizeToolNames?: boolean;
  allowBareToolFallback?: boolean;
}

function toolForMatch(toolName: string, options?: MatcherOptions): string {
  return options?.canonicalizeToolNames === false
    ? toolName
    : canonicalToolName(toolName);
}

/**
 * Normalize path separators to forward slashes for consistent glob matching.
 * This is needed because:
 * - Windows uses backslashes in paths
 * - minimatch expects forward slashes for glob patterns
 * - User settings may contain escaped backslashes (e.g., ".skills\\dir\\**")
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function isWindowsDrivePath(p: string): boolean {
  return /^[a-zA-Z]:\//.test(p);
}

function isWindowsUncPath(p: string): boolean {
  return /^\/\/[^/]+\/[^/]+/.test(p);
}

function isWindowsExtendedDrivePath(p: string): boolean {
  return /^\/\/\?\/[a-zA-Z]:\//.test(p);
}

function isWindowsExtendedUncPath(p: string): boolean {
  return /^\/\/\?\/UNC\/[^/]+\/[^/]+/i.test(p);
}

function isWindowsContext(workingDirectory: string): boolean {
  const normalizedWorkingDir = normalizePath(workingDirectory);
  return (
    process.platform === "win32" ||
    isWindowsDrivePath(normalizedWorkingDir) ||
    normalizedWorkingDir.startsWith("//")
  );
}

function canonicalizeWindowsAbsolutePath(path: string): string {
  let normalized = normalizePath(path);

  if (isWindowsExtendedUncPath(normalized)) {
    normalized = `//${normalized.slice("//?/UNC/".length)}`;
  } else if (isWindowsExtendedDrivePath(normalized)) {
    normalized = normalized.slice("//?/".length);
  }

  if (/^\/+[a-zA-Z]:\//.test(normalized)) {
    normalized = normalized.replace(/^\/+/, "");
  }

  if (isWindowsDrivePath(normalized)) {
    normalized = `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}`;
  }

  return normalized;
}

function isWindowsAbsolutePath(path: string): boolean {
  const canonicalPath = canonicalizeWindowsAbsolutePath(path);
  return isWindowsDrivePath(canonicalPath) || isWindowsUncPath(canonicalPath);
}

function normalizeAbsolutePattern(
  globPattern: string,
  workingDirectory: string,
): string {
  if (isWindowsContext(workingDirectory)) {
    return canonicalizeWindowsAbsolutePath(globPattern);
  }

  // Claude-style Unix absolute path prefix: //absolute/path -> /absolute/path
  if (globPattern.startsWith("//")) {
    return globPattern.slice(1);
  }

  return globPattern;
}

function resolveFilePathForMatching(
  filePath: string,
  workingDirectory: string,
  windowsContext: boolean,
): string {
  if (windowsContext && isWindowsAbsolutePath(filePath)) {
    return canonicalizeWindowsAbsolutePath(filePath);
  }

  const resolved = normalizePath(resolve(workingDirectory, filePath));
  return windowsContext ? canonicalizeWindowsAbsolutePath(resolved) : resolved;
}

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
  options?: MatcherOptions,
): boolean {
  // Extract tool name and file path from query
  // Format: "ToolName(filePath)"
  const queryMatch = query.match(/^([^(]+)\(([\s\S]+)\)$/);
  if (!queryMatch || !queryMatch[1] || !queryMatch[2]) {
    return false;
  }
  const queryTool = toolForMatch(queryMatch[1], options);
  // Normalize path separators for cross-platform compatibility
  const filePath = normalizePath(queryMatch[2]);

  // Extract tool name and glob pattern from permission rule
  // Format: "ToolName(pattern)"
  const patternMatch = pattern.match(/^([^(]+)\(([\s\S]+)\)$/);
  if (!patternMatch || !patternMatch[1] || !patternMatch[2]) {
    // Legacy fallback: allow bare tool names (for rules saved before param suffixes were added)
    if (options?.allowBareToolFallback === false) {
      return false;
    }
    return toolForMatch(pattern, options) === queryTool;
  }
  const patternTool = toolForMatch(patternMatch[1], options);
  if (!patternTool) {
    return false;
  }
  // Normalize path separators for cross-platform compatibility
  let globPattern = normalizePath(patternMatch[2]);

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

  globPattern = normalizeAbsolutePattern(globPattern, workingDirectory);

  // Resolve file path to absolute and normalize separators
  const windowsContext = isWindowsContext(workingDirectory);
  const absoluteFilePath = resolveFilePathForMatching(
    filePath,
    workingDirectory,
    windowsContext,
  );

  // If pattern is absolute, compare directly
  if (globPattern.startsWith("/") || isWindowsAbsolutePath(globPattern)) {
    const patternToMatch = windowsContext
      ? canonicalizeWindowsAbsolutePath(globPattern)
      : globPattern;
    return minimatch(absoluteFilePath, patternToMatch, {
      nocase: windowsContext,
    });
  }

  // If pattern is relative, compare against both:
  // 1. Relative path from working directory
  // 2. Absolute path (for patterns that might match absolute paths)
  const normalizedWorkingDir = normalizePath(workingDirectory);
  const relativeFilePath = filePath.startsWith("/")
    ? absoluteFilePath.replace(`${normalizedWorkingDir}/`, "")
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

export function matchesBashPattern(
  query: string,
  pattern: string,
  options?: MatcherOptions,
): boolean {
  // Extract the command from query
  // Format: "Tool(actual command)" or "Tool()"
  const queryMatch = query.match(/^([^(]+)\(([\s\S]*)\)$/);
  if (
    !queryMatch ||
    queryMatch[1] === undefined ||
    queryMatch[2] === undefined
  ) {
    return false;
  }
  if (toolForMatch(queryMatch[1], options) !== "Bash") {
    return false;
  }
  const rawCommand = queryMatch[2];
  // Extract actual command by stripping cd prefixes from compound commands
  const command = extractActualCommand(rawCommand);

  // Extract the command pattern from permission rule
  // Format: "Tool(command pattern)" or "Tool()"
  const patternMatch = pattern.match(/^([^(]+)\(([\s\S]*)\)$/);
  if (
    !patternMatch ||
    patternMatch[1] === undefined ||
    patternMatch[2] === undefined
  ) {
    if (options?.allowBareToolFallback === false) {
      return false;
    }
    return toolForMatch(pattern, options) === "Bash";
  }
  if (toolForMatch(patternMatch[1], options) !== "Bash") {
    return false;
  }
  const commandPattern = patternMatch[2];

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
export function matchesToolPattern(
  toolName: string,
  pattern: string,
  options?: MatcherOptions,
): boolean {
  const canonicalTool = toolForMatch(toolName, options);
  // Wildcard matches everything
  if (pattern === "*") {
    return true;
  }

  if (toolForMatch(pattern, options) === canonicalTool) {
    return true;
  }

  // Check for tool name match (with or without parens)
  if (pattern === canonicalTool || pattern === `${canonicalTool}()`) {
    return true;
  }

  // Check for tool name prefix (e.g., "WebFetch(...)")
  const patternToolMatch = pattern.match(/^([^(]+)\(/);
  if (patternToolMatch?.[1]) {
    return toolForMatch(patternToolMatch[1], options) === canonicalTool;
  }

  return false;
}
