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

const GENERIC_MATCHED_RULE_REASONS = new Set([
  "Matched deny rule",
  "Matched --disallowedTools flag",
  "Matched ask rule",
]);

/**
 * Format an auto-denial message for a user-facing tool response.
 *
 * Precedence:
 *   1. `customDenyReason` — caller-supplied override (e.g. a hook's
 *      custom message, or a tool-specific failure string). Used verbatim.
 *   2. Generic internal checker reasons ("Matched deny rule", etc.) defer
 *      to `matchedRule` when present so the user sees the actual rule text.
 *   3. `permission.reason` — the detailed explanation set by the permission
 *      check (e.g. "Permission denied by cross-agent memory guard: ...
 *      Set LETTA_MEMORY_SCOPE or pass --memory-scope to authorize").
 *      If it already starts with "Permission denied", keep it verbatim;
 *      otherwise prefix it once with `"Permission denied: "`.
 *   4. `permission.matchedRule` — the short rule label
 *      (e.g. "cross-agent guard", "memory mode"). Prefixed with
 *      `"Permission denied by rule: "`.
 *   5. Final fallback: `"Permission denied: Unknown reason"`.
 */
export function formatPermissionDenial(
  permission: DenialPermissionShape,
  customDenyReason?: string | null,
): string {
  const customReason = customDenyReason?.trim();
  if (customReason) return customReason;

  const reason = permission.reason?.trim();
  const matchedRule = permission.matchedRule?.trim();

  if (reason && matchedRule && GENERIC_MATCHED_RULE_REASONS.has(reason)) {
    return `Permission denied by rule: ${matchedRule}`;
  }

  if (reason) {
    if (/^Permission denied\b/i.test(reason)) {
      return reason;
    }
    return `Permission denied: ${reason}`;
  }

  if (matchedRule) {
    return `Permission denied by rule: ${matchedRule}`;
  }
  return "Permission denied: Unknown reason";
}
