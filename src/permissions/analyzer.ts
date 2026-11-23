import { homedir } from "node:os";
import { dirname, relative, resolve, win32 } from "node:path";
import { resolveGlobalConfigDir } from "@/utils/settings-path";
import {
  canonicalToolName,
  isFileToolName,
  toolNameForPermissionCheck,
} from "./canonical";
import {
  isReadOnlyShellCommand,
  SAFE_GH_COMMANDS,
  SAFE_GIT_SUBCOMMAND_LIST,
} from "./read-only-shell";
import {
  splitShellSegmentsAllowCommandSubstitution,
  tokenizeShellWords,
} from "./shell-analysis";
import {
  extractPrimaryShellCommand,
  unwrapShellLauncherCommand,
} from "./shell-command-normalization";

const SAFE_GIT_COMMANDS: readonly string[] = SAFE_GIT_SUBCOMMAND_LIST;

export interface ApprovalContext {
  recommendedRule: string;

  ruleDescription: string;

  approveAlwaysText: string;

  defaultScope: "project" | "session" | "user";

  allowPersistence: boolean;

  safetyLevel: "safe" | "moderate" | "dangerous";
}

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
  const canonicalTool = canonicalToolName(
    toolNameForPermissionCheck(toolName, toolArgs),
  );
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
        typeof toolArgs.cmd === "string"
          ? toolArgs.cmd
          : typeof toolArgs.command === "string"
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

function analyzeReadApproval(
  filePath: string,
  workingDir: string,
): ApprovalContext {
  const absolutePath = resolvePathForContext(workingDir, filePath);

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

function analyzeWriteApproval(
  _filePath: string,
  _workingDir: string,
): ApprovalContext {
  return {
    recommendedRule: "Write(**)",
    ruleDescription: "all write operations",
    approveAlwaysText: "Yes, allow all writes during this session",
    defaultScope: "session",
    allowPersistence: true,
    safetyLevel: "moderate",
  };
}

function analyzeEditApproval(
  filePath: string,
  workingDir: string,
): ApprovalContext {
  const absolutePath = resolvePathForContext(workingDir, filePath);
  const dirPath = dirnameForContext(absolutePath);

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

  const relativeDirPath = normalizeOsPath(
    relativePathForContext(workingDir, dirPath),
  );
  const pattern =
    relativeDirPath === "" || relativeDirPath === "."
      ? "**"
      : `${relativeDirPath}/**`;

  if (pattern === "**") {
    return {
      recommendedRule: "Edit(**)",
      ruleDescription: "accept edits mode for this session",
      approveAlwaysText: "Yes, switch to accept edits mode for this session",
      defaultScope: "session",
      allowPersistence: true,
      safetyLevel: "safe",
    };
  }

  return {
    recommendedRule: `Edit(${pattern})`,
    ruleDescription: `editing files in ${relativeDirPath || "project"}/`,
    approveAlwaysText: `Yes, allow editing files in ${relativeDirPath || "project"}/ in this project`,
    defaultScope: "project",
    allowPersistence: true,
    safetyLevel: "safe",
  };
}

function analyzeGhApproval(category: string, action: string): ApprovalContext {
  if (!category) {
    return {
      recommendedRule: "Bash(gh:*)",
      ruleDescription: "'gh' commands",
      approveAlwaysText:
        "Yes, and don't ask again for 'gh' commands in this project",
      defaultScope: "project",
      allowPersistence: true,
      safetyLevel: "moderate",
    };
  }

  const allowedActions: Set<string> | null | undefined =
    SAFE_GH_COMMANDS[category];
  const categoryInMap = allowedActions !== undefined;

  const isReadOnly =
    categoryInMap &&
    (allowedActions === null ||
      (action.length > 0 && allowedActions.has(action)));

  const safetyLevel =
    category === "api" ? "moderate" : isReadOnly ? "safe" : "moderate";

  const ruleCmd =
    action.length > 0 && allowedActions !== null
      ? `gh ${category} ${action}`
      : `gh ${category}`;

  return {
    recommendedRule: `Bash(${ruleCmd}:*)`,
    ruleDescription: `'${ruleCmd}' commands`,
    approveAlwaysText: `Yes, and don't ask again for '${ruleCmd}' commands in this project`,
    defaultScope: "project",
    allowPersistence: true,
    safetyLevel,
  };
}

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

export function parseAbsoluteCommandPaths(command: string): string[] {
  const normalized = normalizePathSeparators(
    command.replace(/\\"/g, '"').replace(/\\'/g, "'"),
  );
  const candidates: string[] = [];

  const quotedRegex = /["']((?:[A-Za-z]:)?\/[^"']+)["']/g;
  let quotedMatch: RegExpExecArray | null = quotedRegex.exec(normalized);
  while (quotedMatch) {
    if (quotedMatch[1]) {
      candidates.push(normalizePathSeparators(quotedMatch[1]));
    }
    quotedMatch = quotedRegex.exec(normalized);
  }

  const tokens = normalized.split(/\s+/);
  for (const token of tokens) {
    const cleaned = token
      .replace(/^["'`([{]+/, "")
      .replace(/["'`),;|\]}]+$/g, "");
    if (/^(?:[A-Za-z]:)?\//.test(cleaned)) {
      candidates.push(normalizePathSeparators(cleaned));
    }
  }

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
  const normalizedConfigDir = normalizePathSeparators(
    resolveGlobalConfigDir(),
  ).replace(/\/$/, "");

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
    `^${escapeRegex(normalizedConfigDir)}/agents/[^/]+/(?:memory/)?skills/(.+?)/scripts/`,
  );
  const agentSkill = detect("agent-scoped", agentRegex);
  if (agentSkill) {
    return agentSkill;
  }

  const globalRegex = new RegExp(
    `^${escapeRegex(normalizedConfigDir)}/skills/(.+?)/scripts/`,
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
  const originalCommand = command.trim();
  const normalizedCommand = normalizePathSeparators(originalCommand);
  const rootIndex = normalizedCommand.indexOf(`${skillRootPath}/scripts/`);
  if (rootIndex === -1) {
    return `Bash(${originalCommand})`;
  }

  const rulePrefix = originalCommand.slice(0, rootIndex + skillRootPath.length);
  return `Bash(${rulePrefix}:*)`;
}

function getSkillApprovalText(
  source: SkillSourceLabel,
  skillName: string,
): string {
  return `Yes, and don't ask again for scripts in ${source} skill '${skillName}'`;
}

function buildPackageStyleRule(
  fullCommand: string,
  safetyLevel: "safe" | "moderate",
): ApprovalContext {
  return {
    recommendedRule: `Bash(${fullCommand}:*)`,
    ruleDescription: `'${fullCommand}' commands`,
    approveAlwaysText: `Yes, and don't ask again for '${fullCommand}' commands in this project`,
    defaultScope: "project",
    allowPersistence: true,
    safetyLevel,
  };
}

function containsDangerousFlag(command: string): boolean {
  const segments = splitShellSegmentsAllowCommandSubstitution(command) ?? [
    command,
  ];

  for (const segment of segments) {
    const tokens = tokenizeShellWords(segment);
    if (
      tokens.includes("--force") ||
      tokens.includes("--hard") ||
      tokens.includes("-f")
    ) {
      return true;
    }
  }

  return false;
}

function analyzeBashApproval(
  command: string,
  workingDir: string,
): ApprovalContext {
  const normalizedCommand = unwrapShellLauncherCommand(command);
  const analysisCommand = extractPrimaryShellCommand(normalizedCommand);
  const parts = analysisCommand.trim().split(/\s+/);
  const baseCommand = parts[0] || "";
  const firstArg = parts[1] || "";
  const topLevelGitSubcommand =
    baseCommand === "git" ? extractGitSubcommand(parts) : null;

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

  if (containsDangerousFlag(normalizedCommand)) {
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

  if (baseCommand === "git") {
    const gitSubcommand = topLevelGitSubcommand;

    if (
      gitSubcommand &&
      SAFE_GIT_COMMANDS.includes(gitSubcommand) &&
      isReadOnlyShellCommand(analysisCommand, { allowExternalPaths: true })
    ) {
      return {
        recommendedRule: `Bash(git ${gitSubcommand}:*)`,
        ruleDescription: `'git ${gitSubcommand}' commands`,
        approveAlwaysText: `Yes, and don't ask again for 'git ${gitSubcommand}' commands in this project`,
        defaultScope: "project",
        allowPersistence: true,
        safetyLevel: "safe",
      };
    }

    if (
      gitSubcommand &&
      ["push", "pull", "fetch", "commit", "add"].includes(gitSubcommand)
    ) {
      return {
        recommendedRule: `Bash(git ${gitSubcommand}:*)`,
        ruleDescription: `'git ${gitSubcommand}' commands`,
        approveAlwaysText: `Yes, and don't ask again for 'git ${gitSubcommand}' commands in this project`,
        defaultScope: "project",
        allowPersistence: true,
        safetyLevel: "moderate",
      };
    }

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

  if (baseCommand === "gh") {
    return analyzeGhApproval(firstArg, parts[2] || "");
  }

  if (baseCommand && ["npm", "bun", "yarn", "pnpm"].includes(baseCommand)) {
    const subcommand = firstArg;
    const thirdPart = parts[2];

    if (subcommand === "run" && thirdPart) {
      const fullCommand = `${baseCommand} ${subcommand} ${thirdPart}`;
      return buildPackageStyleRule(fullCommand, "safe");
    }

    if (subcommand) {
      const fullCommand = `${baseCommand} ${subcommand}`;
      return buildPackageStyleRule(fullCommand, "safe");
    }
  }

  if (baseCommand && ["npx", "bunx"].includes(baseCommand)) {
    const subcommand = firstArg;
    if (subcommand) {
      return buildPackageStyleRule(`${baseCommand} ${subcommand}`, "moderate");
    }
  }

  const readOnlyRulePrefix = getReadOnlyRulePrefix(parts);
  if (
    readOnlyRulePrefix &&
    (isReadOnlyShellCommand(analysisCommand, {
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

  const displayCommand =
    analysisCommand.length > 40
      ? `${analysisCommand.slice(0, 40)}...`
      : analysisCommand;

  return {
    recommendedRule: `Bash(${analysisCommand})`,
    ruleDescription: `'${displayCommand}'`,
    approveAlwaysText: `Yes, and don't ask again for '${displayCommand}' in this project`,
    defaultScope: "project",
    allowPersistence: true,
    safetyLevel: "moderate",
  };
}

function extractGitSubcommand(parts: string[]): string | null {
  let index = 1;
  let skipNext = false;

  while (index < parts.length) {
    const token = parts[index];
    if (!token) {
      index += 1;
      continue;
    }

    if (skipNext) {
      skipNext = false;
      index += 1;
      continue;
    }

    if (
      token === "-C" ||
      token === "-c" ||
      token === "--config-env" ||
      token === "--exec-path" ||
      token === "--git-dir" ||
      token === "--namespace" ||
      token === "--super-prefix" ||
      token === "--work-tree"
    ) {
      skipNext = true;
      index += 1;
      continue;
    }

    if (
      (token.startsWith("-C") || token.startsWith("-c")) &&
      token.length > 2
    ) {
      index += 1;
      continue;
    }

    if (
      token.startsWith("--config-env=") ||
      token.startsWith("--exec-path=") ||
      token.startsWith("--git-dir=") ||
      token.startsWith("--namespace=") ||
      token.startsWith("--super-prefix=") ||
      token.startsWith("--work-tree=")
    ) {
      index += 1;
      continue;
    }

    if (token === "--" || token.startsWith("-")) {
      index += 1;
      continue;
    }

    return token;
  }

  return null;
}

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
