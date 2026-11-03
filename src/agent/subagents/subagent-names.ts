/**
 * Subagent configs the model cannot select with `subagent_type`, so Available
 * Agents omits them: `general-purpose` backs the default agent, `fork` backs
 * `fork_context: true`, and the internal types are harness-launched.
 */
export const MODEL_HIDDEN_SUBAGENT_NAMES: ReadonlySet<string> = new Set([
  "general-purpose",
  "fork",
  "init",
  "reflection",
  "memory",
]);
