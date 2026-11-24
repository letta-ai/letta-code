import { resolve, win32 } from "node:path";
import { minimatch } from "minimatch";
import { canonicalToolName } from "./canonical";
import {
  extractAllShellCommands,
  extractPrimaryShellCommand,
  normalizeBashRulePayload,
  unwrapShellLauncherCommand,
} from "./shell-command-normalization";

export interface MatcherOptions {
  canonicalizeToolNames?: boolean;
  allowBareToolFallback?: boolean;
  checkAllSegments?: boolean;
}

function toolForMatch(toolName: string, options?: MatcherOptions): string {
  return options?.canonicalizeToolNames === false
    ? toolName
    : canonicalToolName(toolName);
}

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

export function matchesFilePattern(
  query: string,
  pattern: string,
  workingDirectory: string,
  options?: MatcherOptions,
): boolean {
  const queryMatch = query.match(/^([^(]+)\(([\s\S]+)\)$/);
  if (!queryMatch || !queryMatch[1] || !queryMatch[2]) {
    return false;
  }
  const queryTool = toolForMatch(queryMatch[1], options);
  const filePath = normalizePath(queryMatch[2]);

  const patternMatch = pattern.match(/^([^(]+)\(([\s\S]+)\)$/);
  if (!patternMatch || !patternMatch[1] || !patternMatch[2]) {
    if (options?.allowBareToolFallback === false) {
      return false;
    }
    return toolForMatch(pattern, options) === queryTool;
  }
  const patternTool = toolForMatch(patternMatch[1], options);
  if (!patternTool) {
    return false;
  }
  let globPattern = normalizePath(patternMatch[2]);

  if (queryTool !== patternTool) {
    return false;
  }

  if (globPattern.startsWith("./")) {
    globPattern = globPattern.slice(2);
  }

  if (globPattern.startsWith("~/")) {
    const homedir = process.env.HOME ?? require("node:os").homedir();
    globPattern = globPattern.replace(/^~/, homedir);
  }

  globPattern = normalizeAbsolutePattern(globPattern, workingDirectory);

  const windowsContext = isWindowsContext(workingDirectory);
  const absoluteFilePath = resolveFilePathForMatching(
    filePath,
    workingDirectory,
    windowsContext,
  );

  if (globPattern.startsWith("/") || isWindowsAbsolutePath(globPattern)) {
    const patternToMatch = windowsContext
      ? canonicalizeWindowsAbsolutePath(globPattern)
      : globPattern;
    return minimatch(absoluteFilePath, patternToMatch, {
      nocase: windowsContext,
    });
  }

  const normalizedWorkingDir = normalizePath(workingDirectory);
  const windowsWorkingDir =
    process.platform === "win32"
      ? normalizePath(resolve(workingDirectory))
      : normalizedWorkingDir;
  const relativeFilePath = isWindowsAbsolutePath(filePath)
    ? normalizePath(
        win32.relative(
          canonicalizeWindowsAbsolutePath(windowsWorkingDir),
          absoluteFilePath,
        ),
      )
    : filePath.startsWith("/")
      ? absoluteFilePath.replace(`${normalizedWorkingDir}/`, "")
      : filePath;

  return (
    minimatch(relativeFilePath, globPattern) ||
    minimatch(absoluteFilePath, globPattern)
  );
}

export function matchesBashPattern(
  query: string,
  pattern: string,
  options?: MatcherOptions,
): boolean {
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
  const command = extractPrimaryShellCommand(rawCommand);
  const normalizedRawCommand = normalizeBashRulePayload(rawCommand);
  const normalizedCommand = normalizeBashRulePayload(command);
  const legacyRawCommand = unwrapShellLauncherCommand(rawCommand).trim();
  const legacyCommand = unwrapShellLauncherCommand(command).trim();

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
  const commandPattern = normalizeBashRulePayload(patternMatch[2]);
  const legacyCommandPattern = unwrapShellLauncherCommand(
    patternMatch[2],
  ).trim();
  const commandCandidates = [
    normalizedCommand,
    normalizedRawCommand,
    legacyCommand,
    legacyRawCommand,
  ];

  if (options?.checkAllSegments) {
    for (const segment of extractAllShellCommands(rawCommand)) {
      const normalizedSegment = normalizeBashRulePayload(segment);
      if (!commandCandidates.includes(normalizedSegment)) {
        commandCandidates.push(normalizedSegment);
      }
    }
  }

  if (commandPattern.endsWith(":*")) {
    const prefix = commandPattern.slice(0, -2);
    const legacyPrefix = legacyCommandPattern.endsWith(":*")
      ? legacyCommandPattern.slice(0, -2)
      : null;
    return commandCandidates.some(
      (candidate) =>
        candidate.startsWith(prefix) ||
        (legacyPrefix !== null && candidate.startsWith(legacyPrefix)),
    );
  }

  return commandCandidates.some(
    (candidate) =>
      candidate === commandPattern || candidate === legacyCommandPattern,
  );
}

export function matchesToolPattern(
  toolName: string,
  pattern: string,
  options?: MatcherOptions,
): boolean {
  const canonicalTool = toolForMatch(toolName, options);
  if (pattern === "*") {
    return true;
  }

  if (toolForMatch(pattern, options) === canonicalTool) {
    return true;
  }

  if (pattern === canonicalTool || pattern === `${canonicalTool}()`) {
    return true;
  }

  const patternToolMatch = pattern.match(/^([^(]+)\(/);
  if (patternToolMatch?.[1]) {
    return toolForMatch(patternToolMatch[1], options) === canonicalTool;
  }

  return false;
}
