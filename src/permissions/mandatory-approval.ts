import type { PermissionCheckResult } from "./types";

type ToolArgs = Record<string, unknown>;

export function envFlagEnabled(name: string): boolean {
  const value = process.env[name];
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true";
}

function extractShellCommand(toolArgs: ToolArgs): string | null {
  const command =
    typeof toolArgs.cmd === "string" ? toolArgs.cmd : toolArgs.command;
  if (typeof command === "string") return command;
  return Array.isArray(command) ? command.join(" ") : null;
}

export function getMandatoryApproval(
  canonicalTool: string,
  toolArgs: ToolArgs,
): PermissionCheckResult | null {
  if (canonicalTool !== "Bash") return null;
  const command = extractShellCommand(toolArgs);
  if (
    !command ||
    /(?:^|[\s;&|'"])(?:[^\s;&|]*\/)?letta(?:\.js)?['"]?\s+(?:memory|memfs)\s+read-only(?:\s|$)/.exec(
      command,
    ) === null
  ) {
    return null;
  }
  return {
    decision: "alwaysAsk",
    matchedRule: "Bash(letta memory read-only:*)",
    reason: "Changing memory read-only status requires explicit user approval",
  };
}
