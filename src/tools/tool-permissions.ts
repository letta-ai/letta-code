import type { ToolApprovalPolicy } from "@/mods/types";
import type { ToolName } from "./tool-definitions";

// Tool permissions configuration
export const TOOL_PERMISSIONS: Record<
  ToolName,
  { requiresApproval: boolean; approvalPolicy?: ToolApprovalPolicy }
> = {
  AskUserQuestion: { requiresApproval: true },
  Bash: { requiresApproval: true },
  EnterWorktree: { requiresApproval: true },
  ExitWorktree: { requiresApproval: true },
  Edit: { requiresApproval: true },
  Glob: { requiresApproval: false },
  Grep: { requiresApproval: false },
  TaskStop: { requiresApproval: true },
  memory: { requiresApproval: false },
  memory_apply_patch: { requiresApproval: false },
  Monitor: { requiresApproval: true },
  Read: { requiresApproval: false },
  read_artifact_file: { requiresApproval: false },
  ViewImage: { requiresApproval: false },
  ReadLSP: { requiresApproval: false },
  SetWorkingDirectory: { requiresApproval: false },
  SendAgentMessage: { requiresApproval: true },
  Skill: { requiresApproval: false },
  Task: { requiresApproval: true },
  TaskCreate: { requiresApproval: false },
  TaskGet: { requiresApproval: false },
  TaskList: { requiresApproval: false },
  TaskUpdate: { requiresApproval: false },
  Workflow: { requiresApproval: true },
  Write: { requiresApproval: true },
  write_artifact_file: { requiresApproval: false },
  exec_command: { requiresApproval: true },
  write_stdin: { requiresApproval: false },
  // Additional Codex tools
  ApplyPatch: { requiresApproval: true },
  UpdatePlan: { requiresApproval: false },
};
