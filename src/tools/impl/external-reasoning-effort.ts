/** Validate session-only overrides without changing either CLI's saved defaults. */
export function validateExternalReasoningEffort(
  type: string | undefined,
  effort: unknown,
): string | undefined {
  if (effort === undefined) return undefined;
  if (type !== "claude-code" && type !== "codex") {
    return "reasoning_effort only applies to claude-code and codex workers";
  }
  const values =
    type === "claude-code"
      ? ["low", "medium", "high", "xhigh", "max", "ultracode"]
      : [
          "none",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
          "ultra",
          "persistent",
        ];
  if (typeof effort !== "string" || !values.includes(effort)) {
    return `Invalid reasoning_effort for ${type}; expected one of: ${values.join(", ")}`;
  }
  return undefined;
}

export function assertExternalReasoningEffort(
  type: string,
  effort: unknown,
): void {
  const error = validateExternalReasoningEffort(type, effort);
  if (error) throw new Error(error);
}
