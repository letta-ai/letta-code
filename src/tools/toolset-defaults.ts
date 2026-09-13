import type { ToolName } from "./tool-definitions";

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
  // "MultiEdit",
  // "LS",
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

export const OPENAI_DEFAULT_TOOLS: ToolName[] = [
  "exec_command",
  "write_stdin",
  // TODO(codex-parity): add once request_user_input tool exists in raw codex path.
  // "request_user_input",
  "apply_patch",
  "memory_apply_patch",
  "update_plan",
  "view_image",
  "SendAgentMessage",
];

export const GEMINI_DEFAULT_TOOLS: ToolName[] = [
  "run_shell_command",
  "read_file_gemini",
  "list_directory",
  "glob_gemini",
  "search_file_content",
  "memory",
  ...WORKTREE_TOOL_NAMES,
  "SetWorkingDirectory",
  "replace",
  "write_file_gemini",
  "write_todos",
  "read_many_files",
  "Skill",
  "Task",
  "SendAgentMessage",
];

// PascalCase toolsets for consistency with Skill tool naming.
export const OPENAI_PASCAL_TOOLS: ToolName[] = [
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

export const GEMINI_PASCAL_TOOLS: ToolName[] = [
  "AskUserQuestion",
  ...WORKTREE_TOOL_NAMES,
  "SetWorkingDirectory",
  "memory",
  "Skill",
  "Task",
  "SendAgentMessage",
  "RunShellCommand",
  "ReadFileGemini",
  "ListDirectory",
  "GlobGemini",
  "SearchFileContent",
  "Replace",
  "WriteFileGemini",
  "WriteTodos",
  "ReadManyFiles",
];
