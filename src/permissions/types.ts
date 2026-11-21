
import type { PermissionMode } from "./mode";

/**
 * Permission rules following Claude Code's format
 */
export interface PermissionRules {
  mode?: PermissionMode;
  allow?: string[];
  deny?: string[];
  ask?: string[];
  alwaysAsk?: string[];
  additionalDirectories?: string[];
}

export type PermissionDecision = "allow" | "deny" | "ask" | "alwaysAsk";

export type PermissionRuleType = PermissionDecision;

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

export interface PermissionCheckResult {
  decision: PermissionDecision;
  matchedRule?: string;
  reason?: string;
  trace?: PermissionCheckTrace;
}
