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

export type PermissionEngine = "v1" | "v2";

export interface PermissionTraceEvent {
  stage: string;
  matched?: boolean;
  pattern?: string;
  message?: string;
}

export interface PermissionShadowComparison {
  engine: PermissionEngine;
  decision: PermissionDecision;
  matchedRule?: string;
}

export interface PermissionCheckTrace {
  engine: PermissionEngine;
  toolName: string;
  canonicalToolName: string;
  query: string;
  events: PermissionTraceEvent[];
  shadow?: PermissionShadowComparison;
}

/**
 * Result of a permission check
 */
export interface PermissionCheckResult {
  decision: PermissionDecision;
  matchedRule?: string;
  reason?: string;
  trace?: PermissionCheckTrace;
}
