import type { ToolName } from "./tool-definitions";
import type { ToolsetName } from "./toolset-types";

export const WORKTREE_TOOL_NAMES = new Set<ToolName>([
  "EnterWorktree",
  "ExitWorktree",
]);

/** Built-in tool presets. Availability filters and explicit allowlists apply afterward. */
export const ANTHROPIC_DEFAULT_TOOLS: ToolName[] = [
  "AskUserQuestion",
  "Bash",
  "Monitor",
  "TaskOutput",
  ...WORKTREE_TOOL_NAMES,
  "SetWorkingDirectory",
  "Edit",
  "TaskStop",
  "memory",
  "Read",
  "Skill",
  "Task",
  "SendAgentMessage",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "Write",
];

// OpenAI-family tools.
export const CODEX_TOOLS: ToolName[] = [
  "AskUserQuestion",
  ...WORKTREE_TOOL_NAMES,
  "SetWorkingDirectory",
  "memory_apply_patch",
  "Task",
  "SendAgentMessage",
  "Monitor",
  "TaskOutput",
  "TaskStop",
  "Skill",
  "exec_command",
  "write_stdin",
  "ViewImage",
  "ApplyPatch",
  "UpdatePlan",
];

/** Letta's model-independent toolset with one preferred tool for each job. */
export const LETTA_TOOLS: ToolName[] = [
  "AskUserQuestion",
  "EnterWorktree",
  "ExitWorktree",
  "SetWorkingDirectory",
  "memory",
  "Task",
  "SendAgentMessage",
  "Monitor",
  "TaskOutput",
  "TaskStop",
  "Skill",
  "exec_command",
  "write_stdin",
  "Read",
  "Edit",
  "Write",
  "ViewImage",
  "UpdatePlan",
];

/** Every selectable preset is declared here; auto only chooses a preset. */
export const TOOLSET_TOOLS: Record<ToolsetName, readonly ToolName[]> = {
  default: ANTHROPIC_DEFAULT_TOOLS,
  codex: CODEX_TOOLS,
  letta: LETTA_TOOLS,
  none: [],
};
