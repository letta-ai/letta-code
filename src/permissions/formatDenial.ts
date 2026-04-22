// Format auto-denial messages consistently across the codebase.
//
// Callers previously open-coded this formatter in 10+ places (headless.ts,
// App.tsx, recovery.ts) with subtle inconsistencies in wording and fallback
// order. The single source of truth lives here.

/**
 * Structural shape of a permission-check result — just the fields this
 * formatter needs. Defined locally so callers can pass any object that
 * carries `reason` and/or `matchedRule` without importing the full
 * `PermissionCheckResult` type.
 */
export interface DenialPermissionShape {
  reason?: string;
  matchedRule?: string;
}

/**
 * Format an auto-denial message for a user-facing tool response.
 *
 * Precedence:
 *   1. `customDenyReason` — caller-supplied override (e.g. a hook's
 *      custom message, or a tool-specific failure string). Used verbatim.
 *   2. `permission.reason` — the detailed explanation set by the permission
 *      check (e.g. "Permission denied by cross-agent memory guard: ...
 *      Set LETTA_MEMORY_SCOPE or pass --memory-scope to authorize").
 *      Prefixed with `"Permission denied: "`.
 *   3. `permission.matchedRule` — the short rule label
 *      (e.g. "cross-agent guard", "memory mode"). Prefixed with
 *      `"Permission denied by rule: "` to signal it's a short label
 *      rather than an actionable explanation.
 *   4. Final fallback: `"Permission denied: Unknown reason"`.
 *
 * Why prefer `reason` over `matchedRule`: `reason` carries the actionable
 * context (offending agent ID, how to authorize, which plan file path),
 * while `matchedRule` is just a short tag for the rule that fired. The
 * reverse order was a longstanding bug that hid useful error info.
 */
export function formatPermissionDenial(
  permission: DenialPermissionShape,
  customDenyReason?: string | null,
): string {
  if (customDenyReason) return customDenyReason;
  if (permission.reason) return `Permission denied: ${permission.reason}`;
  if (permission.matchedRule) {
    return `Permission denied by rule: ${permission.matchedRule}`;
  }
  return "Permission denied: Unknown reason";
}
