/** CLI execution options owned by one listener conversation, never process.env. */
export interface RuntimeExecutionSettings {
  tools?: string[];
  preload_skills?: string[];
  allowed_tools: string[];
  disallowed_tools: string[];
  max_turns?: number;
  parent_agent_id?: string;
  agent_role?: "subagent";
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
