import {
  readSubagentDepth,
  SUBAGENT_DEPTH_ENV,
} from "@/utils/subagent-depth-env";

/** CLI execution options owned by one listener conversation, never process.env. */
export interface RuntimeExecutionSettings {
  tools?: string[];
  preload_skills?: string[];
  allowed_tools: string[];
  disallowed_tools: string[];
  max_turns?: number;
  parent_agent_id?: string;
  mcp_agent_id?: string;
  parent_conversation_id?: string;
  agent_role?: "subagent";
  /** Harness-owned nesting depth; see SUBAGENT_DEPTH_ENV. */
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
      (typeof settings.subagent_depth === "number" &&
        Number.isSafeInteger(settings.subagent_depth) &&
        settings.subagent_depth >= 0)) &&
    [
      "parent_agent_id",
      "mcp_agent_id",
      "parent_conversation_id",
      "transcript_path",
      "memory_directory",
    ].every(
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
  delete scoped.LETTA_MCP_AGENT_ID;
  delete scoped.LETTA_PARENT_CONVERSATION_ID;
  delete scoped.LETTA_CODE_AGENT_ROLE;
  delete scoped[SUBAGENT_DEPTH_ENV];
  delete scoped.TRANSCRIPT_PATH;
  delete scoped.MEMORY_DIR;
  delete scoped.LETTA_MEMORY_DIR;
  if (settings.parent_agent_id)
    scoped.LETTA_PARENT_AGENT_ID = settings.parent_agent_id;
  if (settings.mcp_agent_id) scoped.LETTA_MCP_AGENT_ID = settings.mcp_agent_id;
  if (settings.parent_conversation_id)
    scoped.LETTA_PARENT_CONVERSATION_ID = settings.parent_conversation_id;
  if (settings.agent_role) scoped.LETTA_CODE_AGENT_ROLE = settings.agent_role;
  if (settings.subagent_depth !== undefined)
    scoped[SUBAGENT_DEPTH_ENV] = String(settings.subagent_depth);
  if (settings.transcript_path)
    scoped.TRANSCRIPT_PATH = settings.transcript_path;
  if (settings.memory_directory !== undefined) {
    scoped.MEMORY_DIR = settings.memory_directory;
    scoped.LETTA_MEMORY_DIR = settings.memory_directory;
  }
  return scoped;
}

/** Subagent identity a headless child forwards when its turn runs on a listener. */
export function subagentExecutionSettings(
  env: NodeJS.ProcessEnv,
): Pick<
  RuntimeExecutionSettings,
  "parent_agent_id" | "parent_conversation_id" | "agent_role" | "subagent_depth"
> {
  if (env.LETTA_CODE_AGENT_ROLE !== "subagent")
    return { parent_agent_id: env.LETTA_PARENT_AGENT_ID };
  return {
    parent_agent_id: env.LETTA_PARENT_AGENT_ID,
    parent_conversation_id: env.LETTA_PARENT_CONVERSATION_ID,
    agent_role: "subagent",
    subagent_depth: readSubagentDepth(env),
  };
}
