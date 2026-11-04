/** External coding worker harnesses the Agent tool can launch. */
export const EXTERNAL_CODING_AGENT_TYPES = [
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "pi",
] as const;
export type ExternalCodingAgentType =
  (typeof EXTERNAL_CODING_AGENT_TYPES)[number];

export function isExternalCodingAgentType(
  value: string,
): value is ExternalCodingAgentType {
  return (EXTERNAL_CODING_AGENT_TYPES as readonly string[]).includes(value);
}

/**
 * Harnesses every caller-notifying computer can launch. A computer advertises
 * newer harnesses in its `external_harnesses` capability.
 */
const HARNESSES_BEFORE_CAPABILITY: ReadonlySet<string> = new Set([
  "claude-code",
  "codex",
  "opencode",
  "cursor",
]);

/**
 * Whether `type` may be sent as the legacy `subagent_type` wire field, which
 * older listeners understand. Newer harnesses are only sent as `harness`.
 */
export function isLegacyWireHarness(type: ExternalCodingAgentType): boolean {
  return HARNESSES_BEFORE_CAPABILITY.has(type);
}

/** Whether a computer with these capabilities can launch `type`. */
export function computerSupportsHarness(
  type: ExternalCodingAgentType,
  advertised: unknown,
): boolean {
  if (HARNESSES_BEFORE_CAPABILITY.has(type)) return true;
  return Array.isArray(advertised) && advertised.includes(type);
}
