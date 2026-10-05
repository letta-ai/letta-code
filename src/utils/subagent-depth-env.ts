/**
 * Nesting depth of the current agent process: 0 for a root agent, 1 for a
 * child launched through Agent, 2 for that child's child. The harness writes
 * it into every child's launch environment; models never choose it.
 */
export const SUBAGENT_DEPTH_ENV = "LETTA_SUBAGENT_DEPTH";

/** Read the launch depth. A subagent from an older parent counts as depth 1. */
export function readSubagentDepth(env: NodeJS.ProcessEnv): number {
  const raw = env[SUBAGENT_DEPTH_ENV]?.trim();
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return env.LETTA_CODE_AGENT_ROLE === "subagent" ? 1 : 0;
}
