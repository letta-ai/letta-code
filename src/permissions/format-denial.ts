export interface DenialPermissionShape {
  reason?: string;
  matchedRule?: string;
}

const GENERIC_MATCHED_RULE_REASONS = new Set([
  "Matched deny rule",
  "Matched --disallowedTools flag",
  "Matched ask rule",
]);

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
