// src/permissions/types.ts
// Types for Claude Code-compatible permission system

/**
 * Permission rules following Claude Code's format
 */
export interface PermissionRules {
  allow?: string[];
  deny?: string[];
  ask?: string[];
  additionalDirectories?: string[];
}

/**
 * Permission decision for a tool execution
 */
export type PermissionDecision = "allow" | "deny" | "ask";

/**
 * Scope for saving permission rules
 */
export type PermissionScope = "project" | "local" | "user";

/**
 * Result of a permission check
 */
export interface PermissionCheckResult {
  decision: PermissionDecision;
  matchedRule?: string;
  reason?: string;
}
