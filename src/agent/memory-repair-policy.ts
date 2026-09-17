export const MEMORY_REPAIR_SUBAGENT_TYPE = "memory-repair";
export const MEMORY_REPAIR_SESSION_ENV = "LETTA_MEMORY_REPAIR_SESSION";

/** Repair children use the existing checkout without startup or post-turn sync. */
export function isMemoryRepairSession(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[MEMORY_REPAIR_SESSION_ENV] === "1";
}
