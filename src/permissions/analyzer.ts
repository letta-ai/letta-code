// src/permissions/analyzer.ts
// Analyze tool executions and recommend appropriate permission rules

import { homedir } from "node:os";
import { dirname, relative, resolve, win32 } from "node:path";
import { canonicalToolName, isFileToolName } from "./canonical";
import { isReadOnlyShellCommand } from "./readOnlyShell";
import { unwrapShellLauncherCommand } from "./shell-command-normalization";

export interface ApprovalContext {
  // What rule should be saved if user clicks "approve always"
  recommendedRule: string;

  // Human-readable explanation of what the rule does
  ruleDescription: string;

  // Button text for "approve always"
  approveAlwaysText: string;

  // Where to save the rule by default
  defaultScope: "project" | "session" | "user";

  // Should we offer "approve always"?
  allowPersistence: boolean;

  // Safety classification
  safetyLevel: "safe" | "moderate" | "dangerous";
}

/**
 * Analyze a tool execution and determine appropriate approval context
 */
type ToolArgs = Record<string, unknown>;

function normalizeOsPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path);
}

function resolvePathForContext(basePath: string, targetPath: string): string {
  const windows = isWindowsPath(basePath) || isWindowsPath(targetPath);
  return windows
    ? win32.resolve(basePath, targetPath)
    : resolve(basePath, targetPath);
}

function relativePathForContext(basePath: string, targetPath: string): string {
  const windows = isWindowsPath(basePath) || isWindowsPath(targetPath);
  return windows
    ? win32.relative(basePath, targetPath)
    : relative(basePath, targetPath);
}

function isPathWithinDirectory(path: string, directory: string): boolean {
  const windows = isWindowsPath(path) || isWindowsPath(directory);
  const normalizedPath = normalizeOsPath(path);
  const normalizedDirectory = normalizeOsPath(directory);

  const relativePath = normalizeOsPath(
    windows
      ? win32.relative(
          normalizedDirectory.toLowerCase(),
          normalizedPath.toLowerCase(),
        )
      : relativePathForContext(normalizedDirectory, normalizedPath),
  );

  if (relativePath === "") {
    return true;
  }

  return (
    !relativePath.startsWith("../") &&
    relativePath !== ".." &&
    !relativePath.startsWith("/") &&
    !/^[a-zA-Z]:\//.test(relativePath)
  );
}

function dirnameForContext(path: string): string {
  return isWindowsPath(path) ? win32.dirname(path) : dirname(path);
}

function formatAbsoluteRulePath(path: string): string {
  const normalized = normalizeOsPath(path).replace(/\/+$/, "");
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//")) {
    return normalized;
  }
  return `//${normalized.replace(/^\/+/, "")}`;
}

function formatDisplayPath(path: string): string {
  return normalizeOsPath(path).replace(normalizeOsPath(homedir()), "~");
}

export function analyzeApprovalContext(
  toolName: string,
  toolArgs: ToolArgs,
  workingDirectory: string,
): ApprovalContext {
  const canonicalTool = canonicalToolName(toolName);
  const resolveFilePath = () => {
    const candidate =
      toolArgs.file_path ?? toolArgs.path ?? toolArgs.notebook_path ?? "";
    return typeof candidate === "string" ? candidate : "";
  };

  switch (canonicalTool) {
    case "Read":
      return analyzeReadApproval(resolveFilePath(), workingDirectory);

    case "Write":
      return analyzeWriteApproval(resolveFilePath(), workingDirectory);

    case "Edit":
      return analyzeEditApproval(resolveFilePath(), workingDirectory);

    case "Bash":
      return analyzeBashApproval(
        typeof toolArgs.command === "string"
          ? toolArgs.command
          : Array.isArray(toolArgs.command)
            ? toolArgs.command.join(" ")
            : "",
        workingDirectory,
      );

    case "WebFetch":
      return analyzeWebFetchApproval(
        typeof toolArgs.url === "string" ? toolArgs.url : "",
      );

    case "Glob":
    case "Grep":
      return analyzeSearchApproval(
        canonicalTool,
        typeof toolArgs.path === "string" ? toolArgs.path : workingDirectory,
        workingDirectory,
      );

    case "Task":
    case "task":
      return {
        recommendedRule: "Task",
        ruleDescription: "subagent operations",
        approveAlwaysText: "Yes, allow subagent operations during this session",
        defaultScope: "session",
        allowPersistence: true,
        safetyLevel: "moderate",
      };

    default:
      return analyzeDefaultApproval(canonicalTool, toolArgs, workingDirectory);
  }
}

/**
 * Analyze Read tool approval
 */
function analyzeReadApproval(
  filePath: string,
  workingDir: string,
): ApprovalContext {
  const absolutePath = resolvePathForContext(workingDir, filePath);

  // If outside working directory, generalize to parent directory
  if (!isPathWithinDirectory(absolutePath, workingDir)) {
    const dirPath = dirnameForContext(absolutePath);
    const displayPath = formatDisplayPath(dirPath);

    return {
      recommendedRule: `Read(${formatAbsoluteRulePath(dirPath)}/**)`,
      ruleDescription: `reading from ${displayPath}/`,
      approveAlwaysText: `Yes, allow reading from ${displayPath}/ in this project`,
      defaultScope: "project",
      allowPersistence: true,
      safetyLevel: "safe",
    };
  }

  // Inside working directory - use relative path
  const relativePath = normalizeOsPath(
    relativePathForContext(workingDir, absolutePath),
  );
  const relativeDir = dirname(relativePath);
  const pattern =
    relativeDir === "." || relativeDir === "" ? "**" : `${relativeDir}/**`;

  return {
    recommendedRule: `Read(${pattern})`,
    ruleDescription: "reading project files",
    approveAlwaysText: "Yes, allow reading project files during this session",
    defaultScope: "session",
    allowPersistence: true,
    safetyLevel: "safe",
  };
}

/**
 * Analyze Write tool approval
 */
function analyzeWriteApproval(
  _filePath: string,
  _workingDir: string,
): ApprovalContext {
  // Write is potentially dangerous to persist broadly
  // Offer session-level approval only
  return {
    recommendedRule: "Write(**)",
    ruleDescription: "all write operations",
    approveAlwaysText: "Yes, allow all writes during this session",
    defaultScope: "session",
    allowPersistence: true,
    safetyLevel: "moderate",
  };
}

/**
 * Analyze Edit tool approval
 */
function analyzeEditApproval(
  filePath: string,
  workingDir: string,
): ApprovalContext {
  // Edit is safer than Write (file must exist)
  // Can offer project-level for specific directories
  const absolutePath = resolvePathForContext(workingDir, filePath);
  const dirPath = dirnameForContext(absolutePath);

  // If outside working directory, use canonical absolute path pattern
  if (!isPathWithinDirectory(dirPath, workingDir)) {
    const displayPath = formatDisplayPath(dirPath);
    return {
      recommendedRule: `Edit(${formatAbsoluteRulePath(dirPath)}/**)`,
      ruleDescription: `editing files in ${displayPath}/`,
      approveAlwaysText: `Yes, allow editing files in ${displayPath}/ in this project`,
      defaultScope: "project",
      allowPersistence: true,
      safetyLevel: "safe",
    };
  }

  // Inside working directory, use relative path
  const relativeDirPath = normalizeOsPath(
    relativePathForContext(workingDir, dirPath),
  );
  const pattern =
    relativeDirPath === "" || relativeDirPath === "."
      ? "**"
      : `${relativeDirPath}/**`;

  return {
    recommendedRule: `Edit(${pattern})`,
    ruleDescription: `editing files in ${relativeDirPath || "project"}/`,
    approveAlwaysText: `Yes, allow editing files in ${relativeDirPath || "project"}/ in this project`,
    defaultScope: "project",
    allowPersistence: true,
    safetyLevel: "safe",
  };
}

/**
 * Analyze Bash command approval
 */
// Safe read-only commands that can be pattern-matched
const SAFE_READONLY_COMMANDS = [
  "ls",
  "cat",
  "pwd",
  "echo",
  "which",
  "type",
  "whoami",
  "date",
  "grep",
  "find",
  "head",
  "tail",
  "wc",
  "diff",
  "file",
  "stat",
  "curl",
  "rg",
  "ag",
  "ack",
  "fgrep",
  "egrep",
  "jq",
  "yq",
  "tree",
  "less",
  "more",
];

function getReadOnlyRulePrefix(parts: string[]): string | null {
  const baseCommand = parts[0] || "";
  if (!baseCommand) {
    return null;
  }

  if (baseCommand === "sed") {
    const hasInPlace = parts.some(
      (part) => part === "-i" || part.startsWith("-i") || part === "--in-place",
    );
    if (hasInPlace) {
      return null;
    }

    if (parts[1] === "-n") {
      return "sed -n";
    }

    return "sed";
  }

  if (SAFE_READONLY_COMMANDS.includes(baseCommand)) {
    return baseCommand;
  }

  return null;
}

// Commands that should never be auto-approved
const DANGEROUS_COMMANDS = [
  "rm",
  "mv",
  "chmod",
  "chown",
  "sudo",
  "dd",
  "mkfs",
  "fdisk",
  "kill",
  "killall",
];

/**
 * Check if a compound command contains any dangerous commands
 */
function containsDangerousCommand(command: string): boolean {
  const segments = command.split(/\s*(?:&&|\||;)\s*/);
  for (const segment of segments) {
    const baseCmd = segment.trim().split(/\s+/)[0] || "";
    if (DANGEROUS_COMMANDS.includes(baseCmd)) {
      return true;
    }
  }
  return false;
}

type SkillSourceLabel = "project" | "agent-scoped" | "global" | "bundled";

interface SkillScriptInfo {
  source: SkillSourceLabel;
  skillName: string;
  skillRootPath: string;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

function parseAbsoluteCommandPaths(command: string): string[] {
  const normalized = command.replace(/\\"/g, '"').replace(/\\'/g, "'");
  const candidates: string[] = [];

  // Prefer explicit quoted paths first.
  const quotedRegex = /["']((?:[A-Za-z]:)?\/[^"']+)["']/g;
  let quotedMatch: RegExpExecArray | null = quotedRegex.exec(normalized);
  while (quotedMatch) {
    if (quotedMatch[1]) {
      candidates.push(normalizePathSeparators(quotedMatch[1]));
    }
    quotedMatch = quotedRegex.exec(normalized);
  }

  // Also scan whitespace-delimited tokens (handles cd && command chains).
  const tokens = normalized.split(/\s+/);
  for (const token of tokens) {
    const cleaned = token
      .replace(/^["'`([{]+/, "")
      .replace(/["'`),;|\]}]+$/g, "");
    if (/^(?:[A-Za-z]:)?\//.test(cleaned)) {
      candidates.push(normalizePathSeparators(cleaned));
    }
  }

  // Preserve first-seen order while de-duplicating.
  return Array.from(new Set(candidates));
}

function detectSkillScript(
  command: string,
  workingDir: string,
): SkillScriptInfo | null {
  const pathCandidates = parseAbsoluteCommandPaths(command);
  if (pathCandidates.length === 0) {
    return null;
  }

  const normalizedWorkingDir = normalizePathSeparators(workingDir).replace(
    /\/$/,
    "",
  );
  const normalizedHomeDir = normalizePathSeparators(homedir()).replace(
    /\/$/,
    "",
  );

  const detect = (
    source: SkillSourceLabel,
    regex: RegExp,
  ): SkillScriptInfo | null => {
    for (const candidate of pathCandidates) {
      const match = candidate.match(regex);
      if (!match?.[1]) {
        continue;
      }
      const skillName = match[1];
      const skillRootPath = match[0].replace(/\/scripts\/$/, "");
      return { source, skillName, skillRootPath };
    }
    return null;
  };

  const projectRegex = new RegExp(
    `^${escapeRegex(normalizedWorkingDir)}/\\.skills/(.+?)/scripts/`,
  );
  const projectSkill = detect("project", projectRegex);
  if (projectSkill) {
    return projectSkill;
  }

  const agentRegex = new RegExp(
    `^${escapeRegex(normalizedHomeDir)}/\\.letta/agents/[^/]+/skills/(.+?)/scripts/`,
  );
  const agentSkill = detect("agent-scoped", agentRegex);
  if (agentSkill) {
    return agentSkill;
  }

  const globalRegex = new RegExp(
    `^${escapeRegex(normalizedHomeDir)}/\\.letta/skills/(.+?)/scripts/`,
  );
  const globalSkill = detect("global", globalRegex);
  if (globalSkill) {
    return globalSkill;
  }

  const bundledSkill = detect(
    "bundled",
    /\/skills\/builtin\/([^/]+)\/scripts\//,
  );
  if (bundledSkill) {
    return bundledSkill;
  }

  return null;
}

function buildSkillScriptRule(command: string, skillRootPath: string): string {
  const normalizedCommand = normalizePathSeparators(command).trim();
  const rootIndex = normalizedCommand.indexOf(skillRootPath);
  if (rootIndex === -1) {
    return `Bash(${normalizedCommand})`;
  }

  const rulePrefix = normalizedCommand.slice(
    0,
    rootIndex + skillRootPath.length,
  );
  return `Bash(${rulePrefix}:*)`;
}

function getSkillApprovalText(
  source: SkillSourceLabel,
  skillName: string,
): string {
  return `Yes, and don't ask again for scripts in ${source} skill '${skillName}'`;
}

function analyzeBashApproval(
  command: string,
  workingDir: string,
): ApprovalContext {
  const normalizedCommand = unwrapShellLauncherCommand(command);
  const parts = normalizedCommand.trim().split(/\s+/);
  const baseCommand = parts[0] || "";
  const firstArg = parts[1] || "";

  // Check if command contains ANY dangerous commands (including in pipelines)
  if (
    containsDangerousCommand(command) ||
    containsDangerousCommand(normalizedCommand)
  ) {
    return {
      recommendedRule: "",
      ruleDescription: "",
      approveAlwaysText: "",
      defaultScope: "session",
      allowPersistence: false,
      safetyLevel: "dangerous",
    };
  }

  // Check for dangerous flags
  if (
    normalizedCommand.includes("--force") ||
    normalizedCommand.includes("-f") ||
    normalizedCommand.includes("--hard")
  ) {
    return {
      recommendedRule: "",
      ruleDescription: "",
      approveAlwaysText: "",
      defaultScope: "session",
      allowPersistence: false,
      safetyLevel: "dangerous",
    };
  }

  const skillScript = detectSkillScript(normalizedCommand, workingDir);
  if (skillScript) {
    const { source, skillName, skillRootPath } = skillScript;
    return {
      recommendedRule: buildSkillScriptRule(normalizedCommand, skillRootPath),
      ruleDescription: `scripts in ${source} skill '${skillName}'`,
      approveAlwaysText: getSkillApprovalText(source, skillName),
      defaultScope: "project",
      allowPersistence: true,
      safetyLevel: "moderate",
    };
  }

  // Git commands - be specific to subcommand
  if (baseCommand === "git") {
    const gitSubcommand = firstArg;

    // Safe read-only git commands
    const safeGitCommands = ["status", "diff", "log", "show", "branch"];
    if (safeGitCommands.includes(gitSubcommand)) {
      return {
        recommendedRule: `Bash(git ${gitSubcommand}:*)`,
        ruleDescription: `'git ${gitSubcommand}' commands`,
        approveAlwaysText: `Yes, and don't ask again for 'git ${gitSubcommand}' commands in this project`,
        defaultScope: "project",
        allowPersistence: true,
        safetyLevel: "safe",
      };
    }

    // Git write commands - moderate safety
    if (["push", "pull", "fetch", "commit", "add"].includes(gitSubcommand)) {
      return {
        recommendedRule: `Bash(git ${gitSubcommand}:*)`,
        ruleDescription: `'git ${gitSubcommand}' commands`,
        approveAlwaysText: `Yes, and don't ask again for 'git ${gitSubcommand}' commands in this project`,
        defaultScope: "project",
        allowPersistence: true,
        safetyLevel: "moderate",
      };
    }

    // Other git commands - still allow but mark as moderate
    if (gitSubcommand) {
      return {
        recommendedRule: `Bash(git ${gitSubcommand}:*)`,
        ruleDescription: `'git ${gitSubcommand}' commands`,
        approveAlwaysText: `Yes, and don't ask again for 'git ${gitSubcommand}' commands in this project`,
        defaultScope: "project",
        allowPersistence: true,
        safetyLevel: "moderate",
      };
    }
  }

  // Package manager commands
  if (baseCommand && ["npm", "bun", "yarn", "pnpm"].includes(baseCommand)) {
    const subcommand = firstArg;
    const thirdPart = parts[2];

    // Handle "npm run test" format (include both "run" and script name)
    if (subcommand === "run" && thirdPart) {
      const fullCommand = `${baseCommand} ${subcommand} ${thirdPart}`;
      return {
        recommendedRule: `Bash(${fullCommand}:*)`,
        ruleDescription: `'${fullCommand}' commands`,
        approveAlwaysText: `Yes, and don't ask again for '${fullCommand}' commands in this project`,
        defaultScope: "project",
        allowPersistence: true,
        safetyLevel: "safe",
      };
    }

    // Handle other subcommands (npm install, bun build, etc.)
    if (subcommand) {
      const fullCommand = `${baseCommand} ${subcommand}`;
      return {
        recommendedRule: `Bash(${fullCommand}:*)`,
        ruleDescription: `'${fullCommand}' commands`,
        approveAlwaysText: `Yes, and don't ask again for '${fullCommand}' commands in this project`,
        defaultScope: "project",
        allowPersistence: true,
        safetyLevel: "safe",
      };
    }
  }

  // Safe read-only commands
  const readOnlyRulePrefix = getReadOnlyRulePrefix(parts);
  if (
    readOnlyRulePrefix &&
    (isReadOnlyShellCommand(normalizedCommand, {
      allowExternalPaths: true,
    }) ||
      readOnlyRulePrefix === "curl")
  ) {
    return {
      recommendedRule: `Bash(${readOnlyRulePrefix}:*)`,
      ruleDescription: `'${readOnlyRulePrefix}' commands`,
      approveAlwaysText: `Yes, and don't ask again for '${readOnlyRulePrefix}' commands in this project`,
      defaultScope: "project",
      allowPersistence: true,
      safetyLevel: "safe",
    };
  }

  // Handle complex piped/chained commands (cd /path && git diff | head)
  // For pipes (|), the FIRST command is the main one
  // For && and ;, we skip cd prefixes and use the actual command
  if (
    normalizedCommand.includes("&&") ||
    normalizedCommand.includes("|") ||
    normalizedCommand.includes(";")
  ) {
    // First, strip everything after the first pipe - the piped-to command is secondary
    // e.g., "curl --version | head -1" -> analyze "curl --version"
    const beforePipe = (
      normalizedCommand.split("|")[0] ?? normalizedCommand
    ).trim();

    // Now split on && and ; to handle cd prefixes
    const segments = beforePipe.split(/\s*(?:&&|;)\s*/);

    for (const segment of segments) {
      const segmentParts = segment.trim().split(/\s+/);
      const segmentBase = segmentParts[0] || "";
      const segmentArg = segmentParts[1] || "";

      // Skip cd commands - we want the actual command
      if (segmentBase === "cd") {
        continue;
      }

      // Check if this segment is git command
      if (segmentBase === "git") {
        const gitSubcommand = segmentArg;
        const safeGitCommands = ["status", "diff", "log", "show", "branch"];
        const writeGitCommands = ["push", "pull", "fetch", "commit", "add"];

        if (
          safeGitCommands.includes(gitSubcommand) ||
          writeGitCommands.includes(gitSubcommand)
        ) {
          return {
            recommendedRule: `Bash(git ${gitSubcommand}:*)`,
            ruleDescription: `'git ${gitSubcommand}' commands`,
            approveAlwaysText: `Yes, and don't ask again for 'git ${gitSubcommand}' commands in this project`,
            defaultScope: "project",
            allowPersistence: true,
            safetyLevel: safeGitCommands.includes(gitSubcommand)
              ? "safe"
              : "moderate",
          };
        }
      }

      // Check if this segment is npm/bun/yarn/pnpm
      if (segmentBase && ["npm", "bun", "yarn", "pnpm"].includes(segmentBase)) {
        const subcommand = segmentArg;
        const thirdPart = segmentParts[2];

        if (subcommand === "run" && thirdPart) {
          const fullCommand = `${segmentBase} ${subcommand} ${thirdPart}`;
          return {
            recommendedRule: `Bash(${fullCommand}:*)`,
            ruleDescription: `'${fullCommand}' commands`,
            approveAlwaysText: `Yes, and don't ask again for '${fullCommand}' commands in this project`,
            defaultScope: "project",
            allowPersistence: true,
            safetyLevel: "safe",
          };
        }

        if (subcommand) {
          const fullCommand = `${segmentBase} ${subcommand}`;
          return {
            recommendedRule: `Bash(${fullCommand}:*)`,
            ruleDescription: `'${fullCommand}' commands`,
            approveAlwaysText: `Yes, and don't ask again for '${fullCommand}' commands in this project`,
            defaultScope: "project",
            allowPersistence: true,
            safetyLevel: "safe",
          };
        }
      }

      // Check if this segment is a safe read-only command
      const readOnlySegmentPrefix = getReadOnlyRulePrefix(segmentParts);
      if (
        readOnlySegmentPrefix &&
        (isReadOnlyShellCommand(segment.trim(), {
          allowExternalPaths: true,
        }) ||
          readOnlySegmentPrefix === "curl")
      ) {
        return {
          recommendedRule: `Bash(${readOnlySegmentPrefix}:*)`,
          ruleDescription: `'${readOnlySegmentPrefix}' commands`,
          approveAlwaysText: `Yes, and don't ask again for '${readOnlySegmentPrefix}' commands in this project`,
          defaultScope: "project",
          allowPersistence: true,
          safetyLevel: "safe",
        };
      }
    }
  }

  // Default: allow this specific command only
  const displayCommand =
    normalizedCommand.length > 40
      ? `${normalizedCommand.slice(0, 40)}...`
      : normalizedCommand;

  return {
    recommendedRule: `Bash(${normalizedCommand})`,
    ruleDescription: `'${displayCommand}'`,
    approveAlwaysText: `Yes, and don't ask again for '${displayCommand}' in this project`,
    defaultScope: "project",
    allowPersistence: true,
    safetyLevel: "moderate",
  };
}

/**
 * Analyze WebFetch approval
 */
function analyzeWebFetchApproval(url: string): ApprovalContext {
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname;

    return {
      recommendedRule: `WebFetch(${urlObj.protocol}//${domain}/*)`,
      ruleDescription: `requests to ${domain}`,
      approveAlwaysText: `Yes, allow requests to ${domain} in this project`,
      defaultScope: "project",
      allowPersistence: true,
      safetyLevel: "safe",
    };
  } catch {
    // Invalid URL
    return {
      recommendedRule: "WebFetch",
      ruleDescription: "web requests",
      approveAlwaysText: "Yes, allow web requests in this project",
      defaultScope: "project",
      allowPersistence: true,
      safetyLevel: "moderate",
    };
  }
}

/**
 * Analyze Glob/Grep approval
 */
function analyzeSearchApproval(
  toolName: string,
  searchPath: string,
  workingDir: string,
): ApprovalContext {
  const absolutePath = resolvePathForContext(workingDir, searchPath);

  if (!isPathWithinDirectory(absolutePath, workingDir)) {
    const displayPath = formatDisplayPath(absolutePath);

    return {
      recommendedRule: `${toolName}(${formatAbsoluteRulePath(absolutePath)}/**)`,
      ruleDescription: `searching in ${displayPath}/`,
      approveAlwaysText: `Yes, allow searching in ${displayPath}/ in this project`,
      defaultScope: "project",
      allowPersistence: true,
      safetyLevel: "safe",
    };
  }

  return {
    recommendedRule: `${toolName}(**)`,
    ruleDescription: "searching project files",
    approveAlwaysText: "Yes, allow searching project files during this session",
    defaultScope: "session",
    allowPersistence: true,
    safetyLevel: "safe",
  };
}

/**
 * Default approval for unknown tools
 */
function analyzeDefaultApproval(
  toolName: string,
  toolArgs: ToolArgs,
  workingDir: string,
): ApprovalContext {
  if (isFileToolName(toolName)) {
    const candidate =
      toolArgs.file_path ?? toolArgs.path ?? toolArgs.notebook_path ?? "";
    const filePath = typeof candidate === "string" ? candidate : "";
    if (filePath.trim().length > 0) {
      const absolutePath = resolvePathForContext(workingDir, filePath);
      if (!isPathWithinDirectory(absolutePath, workingDir)) {
        const dirPath = dirnameForContext(absolutePath);
        const displayPath = formatDisplayPath(dirPath);
        return {
          recommendedRule: `${toolName}(${formatAbsoluteRulePath(dirPath)}/**)`,
          ruleDescription: `${toolName} in ${displayPath}/`,
          approveAlwaysText: `Yes, allow ${toolName} in ${displayPath}/ in this project`,
          defaultScope: "project",
          allowPersistence: true,
          safetyLevel: "moderate",
        };
      }
    }

    return {
      recommendedRule: `${toolName}(**)`,
      ruleDescription: `${toolName} operations`,
      approveAlwaysText: `Yes, allow ${toolName} operations during this session`,
      defaultScope: "session",
      allowPersistence: true,
      safetyLevel: "moderate",
    };
  }

  return {
    recommendedRule: toolName,
    ruleDescription: `${toolName} operations`,
    approveAlwaysText: `Yes, allow ${toolName} operations during this session`,
    defaultScope: "session",
    allowPersistence: true,
    safetyLevel: "moderate",
  };
}
