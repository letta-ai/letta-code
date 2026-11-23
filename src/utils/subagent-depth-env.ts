export const SUBAGENT_DEPTH_ENV = "LETTA_SUBAGENT_DEPTH";

export function readSubagentDepth(env: NodeJS.ProcessEnv): number {
  const raw = env[SUBAGENT_DEPTH_ENV]?.trim();
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return env.LETTA_CODE_AGENT_ROLE === "subagent" ? 1 : 0;
}
