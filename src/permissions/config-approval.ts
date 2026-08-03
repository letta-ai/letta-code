import type { PermissionCheckResult } from "@/permissions/types";
import { isShellToolName } from "./canonical";

export function envFlagEnabled(name: string): boolean {
  const value = process.env[name];
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true";
}

export function getConfigApproval(
  toolName: string,
  toolArgs: Record<string, unknown>,
): PermissionCheckResult | null {
  if (!isShellToolName(toolName)) return null;
  const command = toolArgs.command ?? toolArgs.cmd;
  if (typeof command !== "string") return null;
  const normalizedCommand = command.replace(/["'\\]/g, "");
  const changesMemoryPolicy =
    /(?:^|\s)(?:memory|memfs)\s+token-limit\s+set(?:\s|$)/.test(
      normalizedCommand,
    );
  if (!changesMemoryPolicy) return null;
  return {
    decision: "alwaysAsk",
    matchedRule: "letta memory token-limit set",
    reason: "Changing protected memory configuration requires approval",
  };
}
