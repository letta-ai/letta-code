import { defineTool, type ToolAssets } from "./define-tool";
import ApplyPatchDescription from "./descriptions/ApplyPatch.md";
import AskUserQuestionDescription from "./descriptions/AskUserQuestion.md";
import BashDescription from "./descriptions/Bash.md";
import BashOutputDescription from "./descriptions/BashOutput.md";
import EditDescription from "./descriptions/Edit.md";
import EnterWorktreeDescription from "./descriptions/EnterWorktree.md";
import ExecCommandDescription from "./descriptions/ExecCommand.md";
import ExitWorktreeDescription from "./descriptions/ExitWorktree.md";
import GlobDescription from "./descriptions/Glob.md";
import GrepDescription from "./descriptions/Grep.md";
import GrepFilesDescription from "./descriptions/GrepFiles.md";
import KillBashDescription from "./descriptions/KillBash.md";
import ListDirCodexDescription from "./descriptions/ListDirCodex.md";
import LSDescription from "./descriptions/LS.md";
import MemoryDescription from "./descriptions/Memory.md";
import MemoryApplyPatchDescription from "./descriptions/MemoryApplyPatch.md";
import MemoryApplyPatchV2Description from "./descriptions/MemoryApplyPatchV2.md";
import MemoryV2Description from "./descriptions/MemoryV2.md";
import MonitorDescription from "./descriptions/Monitor.md";
import MultiEditDescription from "./descriptions/MultiEdit.md";
import ReadDescription from "./descriptions/Read.md";
import ReadArtifactFileDescription from "./descriptions/ReadArtifactFile.md";
import ReadFileCodexDescription from "./descriptions/ReadFileCodex.md";
import ReadLSPDescription from "./descriptions/ReadLSP.md";
import SendAgentMessageDescription from "./descriptions/SendAgentMessage.md";
import SetWorkingDirectoryDescription from "./descriptions/SetWorkingDirectory.md";
import ShellDescription from "./descriptions/Shell.md";
import ShellCommandDescription from "./descriptions/ShellCommand.md";
import SkillDescription from "./descriptions/Skill.md";
import TaskDescription from "./descriptions/Task.md";
import TaskCreateDescription from "./descriptions/TaskCreate.md";
import TaskGetDescription from "./descriptions/TaskGet.md";
import TaskListDescription from "./descriptions/TaskList.md";
import TaskOutputDescription from "./descriptions/TaskOutput.md";
import TaskStopDescription from "./descriptions/TaskStop.md";
import TaskUpdateDescription from "./descriptions/TaskUpdate.md";
import TodoWriteDescription from "./descriptions/TodoWrite.md";
import UpdatePlanDescription from "./descriptions/UpdatePlan.md";
import ViewImageDescription from "./descriptions/ViewImage.md";
import WriteDescription from "./descriptions/Write.md";
import WriteArtifactFileDescription from "./descriptions/WriteArtifactFile.md";
import WriteStdinDescription from "./descriptions/WriteStdin.md";
import { apply_patch } from "./impl/apply-patch";
import { read_artifact_file, write_artifact_file } from "./impl/artifact-files";
import { ask_user_question } from "./impl/ask-user-question";
import { bash } from "./impl/bash";
import { bash_output } from "./impl/bash-output";
import { edit } from "./impl/edit";
import { enter_worktree } from "./impl/enter-worktree";
import { exec_command, write_stdin } from "./impl/exec-command";
import { exit_worktree } from "./impl/exit-worktree";
import { glob } from "./impl/glob";
import { grep } from "./impl/grep";
import { grep_files } from "./impl/grep-files";
import { kill_bash } from "./impl/kill-bash";
import { list_dir } from "./impl/list-dir-codex";
import { ls } from "./impl/ls";
import { memory } from "./impl/memory";
import { memory_apply_patch } from "./impl/memory-apply-patch";
import { monitor } from "./impl/monitor";
import { multi_edit } from "./impl/multi-edit";
import { read } from "./impl/read";
import { read_file } from "./impl/read-file-codex";
import { read_lsp } from "./impl/read-lsp";
import { send_agent_message } from "./impl/send-agent-message";
import { set_working_directory } from "./impl/set-working-directory";
import { shell } from "./impl/shell";
import { shell_command } from "./impl/shell-command";
import { skill } from "./impl/skill";
import { task } from "./impl/task";
import { task_create } from "./impl/task-create";
import { task_get } from "./impl/task-get";
import { task_list } from "./impl/task-list";
import { task_output } from "./impl/task-output";
import { task_stop } from "./impl/task-stop";
import { task_update } from "./impl/task-update";
import { todo_write } from "./impl/todo-write";
import { update_plan } from "./impl/update-plan";
import { view_image } from "./impl/view-image";
import { write } from "./impl/write";

import ApplyPatchSchema from "./schemas/ApplyPatch.json";
import AskUserQuestionSchema from "./schemas/AskUserQuestion.json";
import BashSchema from "./schemas/Bash.json";
import BashOutputSchema from "./schemas/BashOutput.json";
import EditSchema from "./schemas/Edit.json";
import EnterWorktreeSchema from "./schemas/EnterWorktree.json";
import ExecCommandSchema from "./schemas/ExecCommand.json";
import ExitWorktreeSchema from "./schemas/ExitWorktree.json";
import GlobSchema from "./schemas/Glob.json";
import GrepSchema from "./schemas/Grep.json";
import GrepFilesSchema from "./schemas/GrepFiles.json";
import KillBashSchema from "./schemas/KillBash.json";
import ListDirCodexSchema from "./schemas/ListDirCodex.json";
import LSSchema from "./schemas/LS.json";
import MemorySchema from "./schemas/Memory.json";
import MemoryApplyPatchSchema from "./schemas/MemoryApplyPatch.json";
import MemoryV2Schema from "./schemas/MemoryV2.json";
import MonitorSchema from "./schemas/Monitor.json";
import MultiEditSchema from "./schemas/MultiEdit.json";
import ReadSchema from "./schemas/Read.json";
import ReadArtifactFileSchema from "./schemas/ReadArtifactFile.json";
import ReadFileCodexSchema from "./schemas/ReadFileCodex.json";
import ReadLSPSchema from "./schemas/ReadLSP.json";
import SendAgentMessageSchema from "./schemas/SendAgentMessage.json";
import SetWorkingDirectorySchema from "./schemas/SetWorkingDirectory.json";
import ShellSchema from "./schemas/Shell.json";
import ShellCommandSchema from "./schemas/ShellCommand.json";
import SkillSchema from "./schemas/Skill.json";
import TaskSchema from "./schemas/Task.json";
import TaskCreateSchema from "./schemas/TaskCreate.json";
import TaskGetSchema from "./schemas/TaskGet.json";
import TaskListSchema from "./schemas/TaskList.json";
import TaskOutputSchema from "./schemas/TaskOutput.json";
import TaskStopSchema from "./schemas/TaskStop.json";
import TaskUpdateSchema from "./schemas/TaskUpdate.json";
import TodoWriteSchema from "./schemas/TodoWrite.json";
import UpdatePlanSchema from "./schemas/UpdatePlan.json";
import ViewImageSchema from "./schemas/ViewImage.json";
import WriteSchema from "./schemas/Write.json";
import WriteArtifactFileSchema from "./schemas/WriteArtifactFile.json";
import WriteStdinSchema from "./schemas/WriteStdin.json";

const WINDOWS_UNIFIED_EXEC_GUIDANCE = `Windows safety rules:
- Do not compose destructive filesystem commands across shells. Do not enumerate paths in PowerShell and then pass them to \`cmd /c\`, batch builtins, or another shell for deletion or moving. Use one shell end-to-end, prefer native PowerShell cmdlets such as \`Remove-Item\` / \`Move-Item\` with \`-LiteralPath\`, and avoid string-built shell commands for file operations.
- Before any recursive delete or move on Windows, verify the resolved absolute target paths stay within the intended workspace or explicitly named target directory. Never issue a recursive delete or move against a computed path if the final target has not been checked.
- When using \`Start-Process\` to launch a background helper or service, pass \`-WindowStyle Hidden\` unless the user explicitly asked for a visible interactive window. Use visible windows only for interactive tools the user needs to see or control.`;

const WINDOWS_BASH_EXECUTION_GUIDANCE = `Windows execution:
- Despite the tool name, on Windows this tool does not run commands through bash by default. It uses the native Windows shell launcher: PowerShell Core (\`pwsh\`) when available, then Windows PowerShell, then \`cmd.exe\` as fallback.
- Write commands using PowerShell-compatible syntax by default. POSIX/bash constructs such as heredocs, \`export VAR=...\`, and Unix-style shell quoting may not work unless you explicitly invoke a POSIX shell.

${WINDOWS_UNIFIED_EXEC_GUIDANCE}`;

export const ROOT_MEMORY_TOOL_ASSETS = {
  memory: {
    schema: MemoryV2Schema,
    description: MemoryV2Description.trim(),
  },
  memory_apply_patch: {
    schema: MemoryApplyPatchSchema,
    description: MemoryApplyPatchV2Description.trim(),
  },
} as const;

export function buildBashDescriptionForPlatform(
  platform: NodeJS.Platform = process.platform,
): string {
  const baseDescription = BashDescription.trim();
  return platform === "win32"
    ? `${baseDescription}\n\n${WINDOWS_BASH_EXECUTION_GUIDANCE}`
    : baseDescription;
}

function execCommandDescription(): string {
  const baseDescription = ExecCommandDescription.trim();
  return process.platform === "win32"
    ? `${baseDescription}\n\n${WINDOWS_UNIFIED_EXEC_GUIDANCE}`
    : baseDescription;
}

const toolDefinitions = {
  AskUserQuestion: defineTool({
    schema: AskUserQuestionSchema,
    description: AskUserQuestionDescription.trim(),
    impl: ask_user_question,
  }),
  Bash: defineTool({
    schema: BashSchema,
    description: buildBashDescriptionForPlatform(),
    impl: bash,
  }),
  BashOutput: defineTool({
    schema: BashOutputSchema,
    description: BashOutputDescription.trim(),
    impl: bash_output,
  }),
  EnterWorktree: defineTool({
    schema: EnterWorktreeSchema,
    description: EnterWorktreeDescription.trim(),
    impl: enter_worktree,
  }),
  ExitWorktree: defineTool({
    schema: ExitWorktreeSchema,
    description: ExitWorktreeDescription.trim(),
    impl: exit_worktree,
  }),
  Edit: defineTool({
    schema: EditSchema,
    description: EditDescription.trim(),
    impl: edit,
  }),
  Glob: defineTool({
    schema: GlobSchema,
    description: GlobDescription.trim(),
    impl: glob,
  }),
  Grep: defineTool({
    schema: GrepSchema,
    description: GrepDescription.trim(),
    impl: grep,
  }),
  KillBash: defineTool({
    schema: KillBashSchema,
    description: KillBashDescription.trim(),
    impl: kill_bash,
  }),
  TaskOutput: defineTool({
    schema: TaskOutputSchema,
    description: TaskOutputDescription.trim(),
    impl: task_output,
  }),
  TaskStop: defineTool({
    schema: TaskStopSchema,
    description: TaskStopDescription.trim(),
    impl: task_stop,
  }),
  LS: defineTool({
    schema: LSSchema,
    description: LSDescription.trim(),
    impl: ls,
  }),
  memory: defineTool({
    schema: MemorySchema,
    description: MemoryDescription.trim(),
    impl: memory,
  }),
  memory_apply_patch: defineTool({
    schema: MemoryApplyPatchSchema,
    description: MemoryApplyPatchDescription.trim(),
    impl: memory_apply_patch,
  }),
  Monitor: defineTool({
    schema: MonitorSchema,
    description: MonitorDescription.trim(),
    impl: monitor,
  }),
  MultiEdit: defineTool({
    schema: MultiEditSchema,
    description: MultiEditDescription.trim(),
    impl: multi_edit,
  }),
  Read: defineTool({
    schema: ReadSchema,
    description: ReadDescription.trim(),
    impl: read,
  }),
  read_artifact_file: defineTool({
    schema: ReadArtifactFileSchema,
    description: ReadArtifactFileDescription.trim(),
    impl: read_artifact_file,
  }),
  ViewImage: defineTool({
    schema: ViewImageSchema,
    description: ViewImageDescription.trim(),
    impl: view_image,
  }),
  // LSP-enhanced Read - used when LETTA_ENABLE_LSP is set
  ReadLSP: defineTool({
    schema: ReadLSPSchema,
    description: ReadLSPDescription.trim(),
    impl: read_lsp,
  }),
  SendAgentMessage: defineTool({
    schema: SendAgentMessageSchema,
    description: SendAgentMessageDescription.trim(),
    impl: send_agent_message,
  }),
  SetWorkingDirectory: defineTool({
    schema: SetWorkingDirectorySchema,
    description: SetWorkingDirectoryDescription.trim(),
    impl: set_working_directory,
  }),
  Skill: defineTool({
    schema: SkillSchema,
    description: SkillDescription.trim(),
    impl: skill,
  }),
  Task: defineTool({
    schema: TaskSchema,
    description: TaskDescription.trim(),
    impl: task,
  }),
  TaskCreate: defineTool({
    schema: TaskCreateSchema,
    description: TaskCreateDescription.trim(),
    impl: task_create,
  }),
  TaskGet: defineTool({
    schema: TaskGetSchema,
    description: TaskGetDescription.trim(),
    impl: task_get,
  }),
  TaskList: defineTool({
    schema: TaskListSchema,
    description: TaskListDescription.trim(),
    impl: task_list,
  }),
  TaskUpdate: defineTool({
    schema: TaskUpdateSchema,
    description: TaskUpdateDescription.trim(),
    impl: task_update,
  }),
  TodoWrite: defineTool({
    schema: TodoWriteSchema,
    description: TodoWriteDescription.trim(),
    impl: todo_write,
  }),
  Write: defineTool({
    schema: WriteSchema,
    description: WriteDescription.trim(),
    impl: write,
  }),
  write_artifact_file: defineTool({
    schema: WriteArtifactFileSchema,
    description: WriteArtifactFileDescription.trim(),
    impl: write_artifact_file,
  }),
  shell_command: defineTool({
    schema: ShellCommandSchema,
    description: ShellCommandDescription.trim(),
    impl: shell_command,
  }),
  exec_command: defineTool({
    schema: ExecCommandSchema,
    description: execCommandDescription(),
    impl: exec_command,
  }),
  write_stdin: defineTool({
    schema: WriteStdinSchema,
    description: WriteStdinDescription.trim(),
    impl: write_stdin,
  }),
  shell: defineTool({
    schema: ShellSchema,
    description: ShellDescription.trim(),
    impl: shell,
  }),
  read_file: defineTool({
    schema: ReadFileCodexSchema,
    description: ReadFileCodexDescription.trim(),
    impl: read_file,
  }),
  list_dir: defineTool({
    schema: ListDirCodexSchema,
    description: ListDirCodexDescription.trim(),
    impl: list_dir,
  }),
  grep_files: defineTool({
    schema: GrepFilesSchema,
    description: GrepFilesDescription.trim(),
    impl: grep_files,
  }),
  // Additional Codex tools
  ShellCommand: defineTool({
    schema: ShellCommandSchema,
    description: ShellCommandDescription.trim(),
    impl: shell_command,
  }),
  Shell: defineTool({
    schema: ShellSchema,
    description: ShellDescription.trim(),
    impl: shell,
  }),
  ReadFile: defineTool({
    schema: ReadFileCodexSchema,
    description: ReadFileCodexDescription.trim(),
    impl: read_file,
  }),
  ListDir: defineTool({
    schema: ListDirCodexSchema,
    description: ListDirCodexDescription.trim(),
    impl: list_dir,
  }),
  GrepFiles: defineTool({
    schema: GrepFilesSchema,
    description: GrepFilesDescription.trim(),
    impl: grep_files,
  }),
  ApplyPatch: defineTool({
    schema: ApplyPatchSchema,
    description: ApplyPatchDescription.trim(),
    impl: apply_patch,
  }),
  UpdatePlan: defineTool({
    schema: UpdatePlanSchema,
    description: UpdatePlanDescription.trim(),
    impl: update_plan,
  }),
} as const satisfies Record<string, ToolAssets>;

export type ToolName = keyof typeof toolDefinitions;

export const TOOL_DEFINITIONS: Record<ToolName, ToolAssets> = toolDefinitions;
