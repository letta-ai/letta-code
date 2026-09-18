export const MAX_SUBAGENT_DEPTH = 2;

/** Resolve turn-local depth without inheriting another listener conversation's env. */
export function getSubagentDepth(
  env: NodeJS.ProcessEnv = process.env,
  settings?: RuntimeExecutionSettings,
): number {
  const role = settings ? settings.agent_role : env.LETTA_CODE_AGENT_ROLE;
  const parent = settings
    ? settings.parent_agent_id
    : env.LETTA_PARENT_AGENT_ID;
  const isSubagent = role === "subagent" || Boolean(parent);
  const raw = settings ? settings.subagent_depth : env.LETTA_SUBAGENT_DEPTH;
  // A child marker proves ancestry, not its level. Missing depth fails closed.
  if (raw === undefined) return isSubagent ? MAX_SUBAGENT_DEPTH : 0;
  const depth =
    typeof raw === "string" && raw.trim() === "" ? NaN : Number(raw);
  // Fail closed for malformed inherited state, too.
  if (!Number.isSafeInteger(depth) || depth < 0) return MAX_SUBAGENT_DEPTH;
  return isSubagent && depth === 0 ? MAX_SUBAGENT_DEPTH : depth;
}

export function assertSubagentSpawnAllowed(
  settings?: RuntimeExecutionSettings,
): void {
  if (getSubagentDepth(process.env, settings) >= MAX_SUBAGENT_DEPTH) {
    throw new Error("Agent cannot spawn subagents at maximum depth 2.");
  }
}

/** CLI execution options owned by one listener conversation, never process.env. */
export interface RuntimeExecutionSettings {
  tools?: string[];
  preload_skills?: string[];
  allowed_tools: string[];
  disallowed_tools: string[];
  max_turns?: number;
  parent_agent_id?: string;
  agent_role?: "subagent";
  subagent_depth?: number;
  transcript_path?: string;
  memory_directory?: string;
  disable_memory_guard: boolean;
}

export function isRuntimeExecutionSettings(
  value: unknown,
): value is RuntimeExecutionSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  const strings = (items: unknown): items is string[] =>
    Array.isArray(items) && items.every((item) => typeof item === "string");
  return (
    strings(settings.allowed_tools) &&
    strings(settings.disallowed_tools) &&
    (settings.tools === undefined || strings(settings.tools)) &&
    (settings.preload_skills === undefined ||
      strings(settings.preload_skills)) &&
    typeof settings.disable_memory_guard === "boolean" &&
    (settings.max_turns === undefined ||
      (typeof settings.max_turns === "number" &&
        Number.isSafeInteger(settings.max_turns) &&
        settings.max_turns > 0)) &&
    (settings.agent_role === undefined || settings.agent_role === "subagent") &&
    (settings.subagent_depth === undefined ||
      (Number.isSafeInteger(settings.subagent_depth) &&
        Number(settings.subagent_depth) >= 0)) &&
    ["parent_agent_id", "transcript_path", "memory_directory"].every(
      (key) => settings[key] === undefined || typeof settings[key] === "string",
    )
  );
}

export function getRuntimeExecutionEnv(
  env: NodeJS.ProcessEnv,
  settings?: RuntimeExecutionSettings,
): NodeJS.ProcessEnv {
  if (!settings) return env;
  const scoped = { ...env };
  // Absence is meaningful: a child must not inherit another turn's identity.
  delete scoped.LETTA_PARENT_AGENT_ID;
  delete scoped.LETTA_CODE_AGENT_ROLE;
  delete scoped.LETTA_SUBAGENT_DEPTH;
  scoped.LETTA_SUBAGENT_DEPTH = String(getSubagentDepth(env, settings));
  delete scoped.TRANSCRIPT_PATH;
  delete scoped.MEMORY_DIR;
  delete scoped.LETTA_MEMORY_DIR;
  if (settings.parent_agent_id)
    scoped.LETTA_PARENT_AGENT_ID = settings.parent_agent_id;
  if (settings.agent_role) scoped.LETTA_CODE_AGENT_ROLE = settings.agent_role;
  if (settings.transcript_path)
    scoped.TRANSCRIPT_PATH = settings.transcript_path;
  if (settings.memory_directory !== undefined) {
    scoped.MEMORY_DIR = settings.memory_directory;
    scoped.LETTA_MEMORY_DIR = settings.memory_directory;
  }
  return scoped;
}
