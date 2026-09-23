import type { ToolName } from "./tool-definitions";
import type {
  ToolsetName,
  ToolsetOption,
  ToolsetPreference,
} from "./toolset-types";

interface ToolsetDefinition extends Omit<ToolsetOption, "id"> {
  tools: readonly ToolName[];
}

export const WORKTREE_TOOL_NAMES = new Set<ToolName>([
  "EnterWorktree",
  "ExitWorktree",
]);

/** Presets in picker order. Availability filters and explicit allowlists apply afterward. */
export const TOOLSET_CATALOG: Readonly<Record<ToolsetName, ToolsetDefinition>> =
  {
    letta: {
      display_name: "Letta",
      label: "Letta toolset",
      description: "Experimental unified toolset for every model",
      is_featured: true,
      tools: [
        "AskUserQuestion",
        "RequestFileUpload",
        "EnterWorktree",
        "ExitWorktree",
        "SetWorkingDirectory",
        "memory",
        "Task",
        "SendAgentMessage",
        "Monitor",
        "TaskStop",
        "Skill",
        "Workflow",
        "exec_command",
        "write_stdin",
        "Read",
        "Edit",
        "Write",
        "ViewImage",
        "UpdatePlan",
      ],
    },
    none: {
      display_name: "None",
      label: "None",
      description: "Empty built-in preset; keeps connected tools",
      is_featured: true,
      tools: [],
    },
    default: {
      display_name: "Claude",
      label: "Claude toolset",
      description:
        "Optimized for Anthropic models, recommended for all non-OpenAI models",
      is_featured: true,
      tools: [
        "AskUserQuestion",
        "RequestFileUpload",
        "Bash",
        "Monitor",
        "EnterWorktree",
        "ExitWorktree",
        "SetWorkingDirectory",
        "Edit",
        "TaskStop",
        "memory",
        "Read",
        "Skill",
        "Workflow",
        "Task",
        "SendAgentMessage",
        "TaskCreate",
        "TaskGet",
        "TaskList",
        "TaskUpdate",
        "Write",
      ],
    },
    codex: {
      display_name: "Codex",
      label: "Codex toolset",
      description: "Optimized for GPT/Codex models",
      is_featured: true,
      tools: [
        "AskUserQuestion",
        "RequestFileUpload",
        "EnterWorktree",
        "ExitWorktree",
        "SetWorkingDirectory",
        "memory_apply_patch",
        "Task",
        "SendAgentMessage",
        "Monitor",
        "TaskStop",
        "Skill",
        "Workflow",
        "exec_command",
        "write_stdin",
        "ViewImage",
        "ApplyPatch",
        "UpdatePlan",
      ],
    },
  };

/** Auto selects a preset; client-facing options omit the internal tool lists. */
export const TOOLSET_OPTIONS: readonly ToolsetOption[] = [
  {
    id: "auto",
    display_name: "Auto",
    label: "Auto",
    description: "Auto-select based on the model",
    is_featured: true,
  },
  ...(Object.keys(TOOLSET_CATALOG) as ToolsetName[]).map((id) => {
    const { tools: _tools, ...option } = TOOLSET_CATALOG[id];
    return { id, ...option };
  }),
];

export function isToolsetPreference(
  value: unknown,
): value is ToolsetPreference {
  return TOOLSET_OPTIONS.some((option) => option.id === value);
}
