import {
  canonicalizePathLike,
  canonicalToolName,
  isFileToolName,
  isShellToolName,
} from "./canonical";
import { normalizeBashRulePayload } from "./shell-command-normalization";

function splitRule(rule: string): { tool: string; payload: string | null } {
  const match = rule.trim().match(/^([^(]+)(?:\(([\s\S]*)\))?$/);
  if (!match?.[1]) {
    return { tool: rule.trim(), payload: null };
  }

  return {
    tool: match[1].trim(),
    payload: match[2] !== undefined ? match[2] : null,
  };
}

export function normalizePermissionRule(rule: string): string {
  const { tool, payload } = splitRule(rule);
  const canonicalTool = canonicalToolName(tool);

  if (payload === null) {
    return canonicalTool;
  }

  if (isShellToolName(canonicalTool)) {
    return `Bash(${normalizeBashRulePayload(payload)})`;
  }

  if (isFileToolName(canonicalTool)) {
    return `${canonicalTool}(${canonicalizePathLike(payload)})`;
  }

  return `${canonicalTool}(${payload.trim()})`;
}

export function permissionRulesEquivalent(
  left: string,
  right: string,
): boolean {
  return normalizePermissionRule(left) === normalizePermissionRule(right);
}
