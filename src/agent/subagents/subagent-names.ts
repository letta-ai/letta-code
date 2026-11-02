/**
 * Subagents only the harness launches (through the launcher's `subagentType`
 * option); the Agent tool rejects them as `subagent_type`.
 */
export const INTERNAL_SUBAGENT_TYPES: ReadonlySet<string> = new Set([
  "init",
  "reflection",
  "memory",
]);

/**
 * Subagent configs the model cannot select with `subagent_type`, so Available
 * Agents omits them: `general-purpose` backs the default agent, `fork` backs
 * `fork_context: true`, and the internal types are harness-launched.
 */
export const MODEL_HIDDEN_SUBAGENT_NAMES: ReadonlySet<string> = new Set([
  "general-purpose",
  "fork",
  ...INTERNAL_SUBAGENT_TYPES,
]);
