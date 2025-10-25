// src/permissions/analyzer.ts
// Analyze tool executions and recommend appropriate permission rules

import { dirname, resolve } from "node:path";

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

export function analyzeApprovalContext(
  toolName: string,
  toolArgs: ToolArgs,
  workingDirectory: string,
): ApprovalContext {
  const resolveFilePath = () => {
    const candidate =
      toolArgs.file_path ?? toolArgs.path ?? toolArgs.notebook_path ?? "";
    return typeof candidate === "string" ? candidate : "";
  };

  switch (toolName) {
    case "Read":
      return analyzeReadApproval(resolveFilePath(), workingDirectory);

    case "Write":
      return analyzeWriteApproval(resolveFilePath(), workingDirectory);

    case "Edit":
    case "MultiEdit":
      return analyzeEditApproval(resolveFilePath(), workingDirectory);

    case "Bash":
      return analyzeBashApproval(
        typeof toolArgs.command === "string" ? toolArgs.command : "",
        workingDirectory,
      );

    case "WebFetch":
      return analyzeWebFetchApproval(
        typeof toolArgs.url === "string" ? toolArgs.url : "",
      );

    case "Glob":
    case "Grep":
      return analyzeSearchApproval(
        toolName,
        typeof toolArgs.path === "string" ? toolArgs.path : workingDirectory,
        workingDirectory,
      );

    default:
      return analyzeDefaultApproval(toolName);
  }
}

/**
 * Analyze Read tool approval
 */
function analyzeReadApproval(
  filePath: string,
  workingDir: string,
): ApprovalContext {
  const absolutePath = resolve(workingDir, filePath);

  // If outside working directory, generalize to parent directory
  if (!absolutePath.startsWith(workingDir)) {
    const dirPath = dirname(absolutePath);
    const displayPath = dirPath.replace(require("node:os").homedir(), "~");

    return {
      recommendedRule: `Read(${dirPath}/**)`,
      ruleDescription: `reading from ${displayPath}/`,
      approveAlwaysText: `Yes, allow reading from ${displayPath}/ in this project`,
      defaultScope: "project",
      allowPersistence: true,
      safetyLevel: "safe",
    };
  }

  // Inside working directory - shouldn't normally be asked, but offer session approval
  return {
    recommendedRule: `Read(${workingDir}/**)`,
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
  const absolutePath = resolve(workingDir, filePath);
  const dirPath = dirname(absolutePath);
  const relativeDirPath = dirPath.startsWith(workingDir)
    ? dirPath.slice(workingDir.length + 1)
    : dirPath;

  return {
    recommendedRule: `Edit(${relativeDirPath}/**)`,
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
function analyzeBashApproval(
  command: string,
  _workingDir: string,
): ApprovalContext {
  const parts = command.trim().split(/\s+/);
  const baseCommand = parts[0];
  const firstArg = parts[1] || "";

  // Dangerous commands - no persistence
  const dangerousCommands = [
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

  if (dangerousCommands.includes(baseCommand)) {
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
    command.includes("--force") ||
    command.includes("-f") ||
    command.includes("--hard")
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
  if (["npm", "bun", "yarn", "pnpm"].includes(baseCommand)) {
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
  const safeCommands = [
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
  ];

  if (safeCommands.includes(baseCommand)) {
    return {
      recommendedRule: `Bash(${baseCommand}:*)`,
      ruleDescription: `'${baseCommand}' commands`,
      approveAlwaysText: `Yes, and don't ask again for '${baseCommand}' commands in this project`,
      defaultScope: "project",
      allowPersistence: true,
      safetyLevel: "safe",
    };
  }

  // Default: allow this specific command only
  const displayCommand =
    command.length > 40 ? `${command.slice(0, 40)}...` : command;

  return {
    recommendedRule: `Bash(${command})`,
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
  const absolutePath = resolve(workingDir, searchPath);

  if (!absolutePath.startsWith(workingDir)) {
    const displayPath = absolutePath.replace(require("node:os").homedir(), "~");

    return {
      recommendedRule: `${toolName}(${absolutePath}/**)`,
      ruleDescription: `searching in ${displayPath}/`,
      approveAlwaysText: `Yes, allow searching in ${displayPath}/ in this project`,
      defaultScope: "project",
      allowPersistence: true,
      safetyLevel: "safe",
    };
  }

  return {
    recommendedRule: `${toolName}(${workingDir}/**)`,
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
function analyzeDefaultApproval(toolName: string): ApprovalContext {
  return {
    recommendedRule: toolName,
    ruleDescription: `${toolName} operations`,
    approveAlwaysText: `Yes, allow ${toolName} operations during this session`,
    defaultScope: "session",
    allowPersistence: true,
    safetyLevel: "moderate",
  };
}
