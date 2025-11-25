// src/permissions/checker.ts
// Main permission checking logic

import { resolve } from "node:path";
import { cliPermissions } from "./cli";
import {
  matchesBashPattern,
  matchesFilePattern,
  matchesToolPattern,
} from "./matcher";
import { permissionMode } from "./mode";
import { sessionPermissions } from "./session";
import type {
  PermissionCheckResult,
  PermissionDecision,
  PermissionRules,
} from "./types";

/**
 * Tools that don't require approval within working directory
 */
const WORKING_DIRECTORY_TOOLS = ["Read", "Glob", "Grep", "LS"];

/**
 * Check permission for a tool execution.
 *
 * Decision logic:
 * 1. Check deny rules from settings (first match wins) → DENY
 * 2. Check CLI disallowedTools (--disallowedTools flag) → DENY
 * 3. Check permission mode (--permission-mode flag) → ALLOW or DENY
 * 4. Check CLI allowedTools (--allowedTools flag) → ALLOW
 * 5. For Read/Glob/Grep within working directory → ALLOW
 * 6. Check session allow rules (first match wins) → ALLOW
 * 7. Check allow rules from settings (first match wins) → ALLOW
 * 8. Check ask rules from settings (first match wins) → ASK
 * 9. Fall back to default behavior for tool → ASK or ALLOW
 *
 * @param toolName - Name of the tool (e.g., "Read", "Bash", "Write")
 * @param toolArgs - Tool arguments (contains file paths, commands, etc.)
 * @param permissions - Loaded permission rules
 * @param workingDirectory - Current working directory
 */
type ToolArgs = Record<string, unknown>;

export function checkPermission(
  toolName: string,
  toolArgs: ToolArgs,
  permissions: PermissionRules,
  workingDirectory: string = process.cwd(),
): PermissionCheckResult {
  // Build permission query string
  const query = buildPermissionQuery(toolName, toolArgs);

  // Get session rules
  const sessionRules = sessionPermissions.getRules();

  // Check deny rules FIRST (highest priority - overrides everything including working directory)
  if (permissions.deny) {
    for (const pattern of permissions.deny) {
      if (matchesPattern(toolName, query, pattern, workingDirectory)) {
        return {
          decision: "deny",
          matchedRule: pattern,
          reason: "Matched deny rule",
        };
      }
    }
  }

  // Check CLI disallowedTools (second highest priority - overrides all allow rules)
  const disallowedTools = cliPermissions.getDisallowedTools();
  for (const pattern of disallowedTools) {
    if (matchesPattern(toolName, query, pattern, workingDirectory)) {
      return {
        decision: "deny",
        matchedRule: `${pattern} (CLI)`,
        reason: "Matched --disallowedTools flag",
      };
    }
  }

  // Check permission mode (applies before CLI allow rules but after deny rules)
  const modeOverride = permissionMode.checkModeOverride(toolName);
  if (modeOverride) {
    const currentMode = permissionMode.getMode();
    return {
      decision: modeOverride,
      matchedRule: `${currentMode} mode`,
      reason: `Permission mode: ${currentMode}`,
    };
  }

  // Check CLI allowedTools (third priority - overrides settings but not deny rules)
  const allowedTools = cliPermissions.getAllowedTools();
  for (const pattern of allowedTools) {
    if (matchesPattern(toolName, query, pattern, workingDirectory)) {
      return {
        decision: "allow",
        matchedRule: `${pattern} (CLI)`,
        reason: "Matched --allowedTools flag",
      };
    }
  }

  // After checking CLI overrides, check if Read/Glob/Grep within working directory
  if (WORKING_DIRECTORY_TOOLS.includes(toolName)) {
    const filePath = extractFilePath(toolArgs);
    if (
      filePath &&
      isWithinAllowedDirectories(filePath, permissions, workingDirectory)
    ) {
      return {
        decision: "allow",
        reason: "Within working directory",
      };
    }
  }

  // Check session allow rules (higher precedence than persisted allow)
  if (sessionRules.allow) {
    for (const pattern of sessionRules.allow) {
      if (matchesPattern(toolName, query, pattern, workingDirectory)) {
        return {
          decision: "allow",
          matchedRule: `${pattern} (session)`,
          reason: "Matched session allow rule",
        };
      }
    }
  }

  // Check persisted allow rules
  if (permissions.allow) {
    for (const pattern of permissions.allow) {
      if (matchesPattern(toolName, query, pattern, workingDirectory)) {
        return {
          decision: "allow",
          matchedRule: pattern,
          reason: "Matched allow rule",
        };
      }
    }
  }

  // Check ask rules
  if (permissions.ask) {
    for (const pattern of permissions.ask) {
      if (matchesPattern(toolName, query, pattern, workingDirectory)) {
        return {
          decision: "ask",
          matchedRule: pattern,
          reason: "Matched ask rule",
        };
      }
    }
  }

  // Fall back to tool defaults
  return {
    decision: getDefaultDecision(toolName),
    reason: "Default behavior for tool",
  };
}

/**
 * Extract file path from tool arguments
 */
function extractFilePath(toolArgs: ToolArgs): string | null {
  // Different tools use different parameter names
  if (typeof toolArgs.file_path === "string" && toolArgs.file_path.length > 0) {
    return toolArgs.file_path;
  }
  if (typeof toolArgs.path === "string" && toolArgs.path.length > 0) {
    return toolArgs.path;
  }
  if (
    typeof toolArgs.notebook_path === "string" &&
    toolArgs.notebook_path.length > 0
  ) {
    return toolArgs.notebook_path;
  }
  return null;
}

/**
 * Check if file path is within allowed directories
 * (working directory + additionalDirectories)
 */
function isWithinAllowedDirectories(
  filePath: string,
  permissions: PermissionRules,
  workingDirectory: string,
): boolean {
  const absolutePath = resolve(workingDirectory, filePath);

  // Check if within working directory
  if (absolutePath.startsWith(workingDirectory)) {
    return true;
  }

  // Check additionalDirectories
  if (permissions.additionalDirectories) {
    for (const dir of permissions.additionalDirectories) {
      const resolvedDir = resolve(workingDirectory, dir);
      if (absolutePath.startsWith(resolvedDir)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Build permission query string for a tool execution
 */
function buildPermissionQuery(toolName: string, toolArgs: ToolArgs): string {
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
    case "Glob":
    case "Grep": {
      // File tools: "ToolName(path/to/file)"
      const filePath = extractFilePath(toolArgs);
      return filePath ? `${toolName}(${filePath})` : toolName;
    }

    case "Bash": {
      // Bash: "Bash(command with args)"
      const command =
        typeof toolArgs.command === "string" ? toolArgs.command : "";
      return `Bash(${command})`;
    }

    default:
      // Other tools: just the tool name
      return toolName;
  }
}

/**
 * Check if query matches a permission pattern
 */
function matchesPattern(
  toolName: string,
  query: string,
  pattern: string,
  workingDirectory: string,
): boolean {
  // File tools use glob matching
  if (["Read", "Write", "Edit", "Glob", "Grep"].includes(toolName)) {
    return matchesFilePattern(query, pattern, workingDirectory);
  }

  // Bash uses prefix matching
  if (toolName === "Bash") {
    return matchesBashPattern(query, pattern);
  }

  // Other tools use simple name matching
  return matchesToolPattern(toolName, pattern);
}

/**
 * Get default decision for a tool (when no rules match)
 */
function getDefaultDecision(toolName: string): PermissionDecision {
  // Tools that default to auto-allow (read-only operations)
  const autoAllowTools = ["Read", "Glob", "Grep", "LS", "TodoWrite"];

  if (autoAllowTools.includes(toolName)) {
    return "allow";
  }

  // Everything else defaults to ask
  return "ask";
}
