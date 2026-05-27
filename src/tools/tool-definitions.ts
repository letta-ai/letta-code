import ApplyPatchDescription from "./descriptions/ApplyPatch.md";
import AskUserQuestionDescription from "./descriptions/AskUserQuestion.md";
import BashDescription from "./descriptions/Bash.md";
import BashOutputDescription from "./descriptions/BashOutput.md";
import CreateGoalDescription from "./descriptions/CreateGoal.md";
import CreateWorktreeDescription from "./descriptions/CreateWorktree.md";
import EditDescription from "./descriptions/Edit.md";
import ExecCommandDescription from "./descriptions/ExecCommand.md";
import GetGoalDescription from "./descriptions/GetGoal.md";
import GlobDescription from "./descriptions/Glob.md";
// Gemini toolset
import GlobGeminiDescription from "./descriptions/GlobGemini.md";
import GrepDescription from "./descriptions/Grep.md";
import GrepFilesDescription from "./descriptions/GrepFiles.md";
import KillBashDescription from "./descriptions/KillBash.md";
import ListDirCodexDescription from "./descriptions/ListDirCodex.md";
import ListDirectoryGeminiDescription from "./descriptions/ListDirectoryGemini.md";
import LSDescription from "./descriptions/LS.md";
import MemoryDescription from "./descriptions/Memory.md";
import MemoryApplyPatchDescription from "./descriptions/MemoryApplyPatch.md";
import MessageChannelDescription from "./descriptions/MessageChannel.md";
import MultiEditDescription from "./descriptions/MultiEdit.md";
import ReadDescription from "./descriptions/Read.md";
import ReadFileCodexDescription from "./descriptions/ReadFileCodex.md";
import ReadFileGeminiDescription from "./descriptions/ReadFileGemini.md";
import ReadLSPDescription from "./descriptions/ReadLSP.md";
import ReadManyFilesGeminiDescription from "./descriptions/ReadManyFilesGemini.md";
import ReplaceGeminiDescription from "./descriptions/ReplaceGemini.md";
import RunShellCommandGeminiDescription from "./descriptions/RunShellCommandGemini.md";
import SearchFileContentGeminiDescription from "./descriptions/SearchFileContentGemini.md";
import ShellDescription from "./descriptions/Shell.md";
import ShellCommandDescription from "./descriptions/ShellCommand.md";
import SkillDescription from "./descriptions/Skill.md";
import TaskDescription from "./descriptions/Task.md";
import TaskOutputDescription from "./descriptions/TaskOutput.md";
import TaskStopDescription from "./descriptions/TaskStop.md";
import TodoWriteDescription from "./descriptions/TodoWrite.md";
import UpdateGoalDescription from "./descriptions/UpdateGoal.md";
import UpdatePlanDescription from "./descriptions/UpdatePlan.md";
import ViewImageDescription from "./descriptions/ViewImage.md";
import WriteDescription from "./descriptions/Write.md";
import WriteFileGeminiDescription from "./descriptions/WriteFileGemini.md";
import WriteStdinDescription from "./descriptions/WriteStdin.md";
import WriteTodosGeminiDescription from "./descriptions/WriteTodosGemini.md";
import { apply_patch } from "./impl/apply-patch";
import { ask_user_question } from "./impl/ask-user-question";
import { bash } from "./impl/bash";
import { bash_output } from "./impl/bash-output";
import { create_goal } from "./impl/create-goal";
import { create_worktree } from "./impl/create-worktree";
import { edit } from "./impl/edit";
import { exec_command, write_stdin } from "./impl/exec-command";
import { get_goal } from "./impl/get-goal";
import { glob } from "./impl/glob";
// Gemini toolset
import { glob_gemini } from "./impl/glob-gemini";
import { grep } from "./impl/grep";
import { grep_files } from "./impl/grep-files";
import { kill_bash } from "./impl/kill-bash";
import { list_dir } from "./impl/list-dir-codex";
import { list_directory } from "./impl/list-directory-gemini";
import { ls } from "./impl/ls";
import { memory } from "./impl/memory";
import { memory_apply_patch } from "./impl/memory-apply-patch";
import { message_channel } from "./impl/message-channel";
import { multi_edit } from "./impl/multi-edit";
import { read } from "./impl/read";
import { read_file } from "./impl/read-file-codex";
import { read_file_gemini } from "./impl/read-file-gemini";
import { read_lsp } from "./impl/read-lsp";
import { read_many_files } from "./impl/read-many-files-gemini";
import { replace } from "./impl/replace-gemini";
import { run_shell_command } from "./impl/run-shell-command-gemini";
import { search_file_content } from "./impl/search-file-content-gemini";
import { shell } from "./impl/shell";
import { shell_command } from "./impl/shell-command";
import { skill } from "./impl/skill";
import { task } from "./impl/task";
import { task_output } from "./impl/task-output";
import { task_stop } from "./impl/task-stop";
import { todo_write } from "./impl/todo-write";
import { update_goal } from "./impl/update-goal";
import { update_plan } from "./impl/update-plan";
import { view_image } from "./impl/view-image";
import { write } from "./impl/write";
import { write_file_gemini } from "./impl/write-file-gemini";
import { write_todos } from "./impl/write-todos-gemini";

import ApplyPatchSchema from "./schemas/ApplyPatch.json";
import AskUserQuestionSchema from "./schemas/AskUserQuestion.json";
import BashSchema from "./schemas/Bash.json";
import BashOutputSchema from "./schemas/BashOutput.json";
import CreateGoalSchema from "./schemas/CreateGoal.json";
import CreateWorktreeSchema from "./schemas/CreateWorktree.json";
import EditSchema from "./schemas/Edit.json";
import ExecCommandSchema from "./schemas/ExecCommand.json";
import GetGoalSchema from "./schemas/GetGoal.json";
import GlobSchema from "./schemas/Glob.json";
// Gemini toolset
import GlobGeminiSchema from "./schemas/GlobGemini.json";
import GrepSchema from "./schemas/Grep.json";
import GrepFilesSchema from "./schemas/GrepFiles.json";
import KillBashSchema from "./schemas/KillBash.json";
import ListDirCodexSchema from "./schemas/ListDirCodex.json";
import ListDirectoryGeminiSchema from "./schemas/ListDirectoryGemini.json";
import LSSchema from "./schemas/LS.json";
import MemorySchema from "./schemas/Memory.json";
import MemoryApplyPatchSchema from "./schemas/MemoryApplyPatch.json";
import MessageChannelSchema from "./schemas/MessageChannel.json";
import MultiEditSchema from "./schemas/MultiEdit.json";
import ReadSchema from "./schemas/Read.json";
import ReadFileCodexSchema from "./schemas/ReadFileCodex.json";
import ReadFileGeminiSchema from "./schemas/ReadFileGemini.json";
import ReadLSPSchema from "./schemas/ReadLSP.json";
import ReadManyFilesGeminiSchema from "./schemas/ReadManyFilesGemini.json";
import ReplaceGeminiSchema from "./schemas/ReplaceGemini.json";
import RunShellCommandGeminiSchema from "./schemas/RunShellCommandGemini.json";
import SearchFileContentGeminiSchema from "./schemas/SearchFileContentGemini.json";
import ShellSchema from "./schemas/Shell.json";
import ShellCommandSchema from "./schemas/ShellCommand.json";
import SkillSchema from "./schemas/Skill.json";
import TaskSchema from "./schemas/Task.json";
import TaskOutputSchema from "./schemas/TaskOutput.json";
import TaskStopSchema from "./schemas/TaskStop.json";
import TodoWriteSchema from "./schemas/TodoWrite.json";
import UpdateGoalSchema from "./schemas/UpdateGoal.json";
import UpdatePlanSchema from "./schemas/UpdatePlan.json";
import ViewImageSchema from "./schemas/ViewImage.json";
import WriteSchema from "./schemas/Write.json";
import WriteFileGeminiSchema from "./schemas/WriteFileGemini.json";
import WriteStdinSchema from "./schemas/WriteStdin.json";
import WriteTodosGeminiSchema from "./schemas/WriteTodosGemini.json";

const WINDOWS_UNIFIED_EXEC_GUIDANCE = `Windows safety rules:
- Do not compose destructive filesystem commands across shells. Do not enumerate paths in PowerShell and then pass them to \`cmd /c\`, batch builtins, or another shell for deletion or moving. Use one shell end-to-end, prefer native PowerShell cmdlets such as \`Remove-Item\` / \`Move-Item\` with \`-LiteralPath\`, and avoid string-built shell commands for file operations.
- Before any recursive delete or move on Windows, verify the resolved absolute target paths stay within the intended workspace or explicitly named target directory. Never issue a recursive delete or move against a computed path if the final target has not been checked.
- When using \`Start-Process\` to launch a background helper or service, pass \`-WindowStyle Hidden\` unless the user explicitly asked for a visible interactive window. Use visible windows only for interactive tools the user needs to see or control.`;

function execCommandDescription(): string {
  const baseDescription = ExecCommandDescription.trim();
  return process.platform === "win32"
    ? `${baseDescription}\n\n${WINDOWS_UNIFIED_EXEC_GUIDANCE}`
    : baseDescription;
}

type ToolImplementation = (args: Record<string, unknown>) => Promise<unknown>;

interface ToolAssets {
  schema: Record<string, unknown>;
  description: string;
  impl: ToolImplementation;
}

const toolDefinitions = {
  AskUserQuestion: {
    schema: AskUserQuestionSchema,
    description: AskUserQuestionDescription.trim(),
    impl: ask_user_question as unknown as ToolImplementation,
  },
  Bash: {
    schema: BashSchema,
    description: BashDescription.trim(),
    impl: bash as unknown as ToolImplementation,
  },
  BashOutput: {
    schema: BashOutputSchema,
    description: BashOutputDescription.trim(),
    impl: bash_output as unknown as ToolImplementation,
  },
  CreateWorktree: {
    schema: CreateWorktreeSchema,
    description: CreateWorktreeDescription.trim(),
    impl: create_worktree as unknown as ToolImplementation,
  },
  Edit: {
    schema: EditSchema,
    description: EditDescription.trim(),
    impl: edit as unknown as ToolImplementation,
  },
  Glob: {
    schema: GlobSchema,
    description: GlobDescription.trim(),
    impl: glob as unknown as ToolImplementation,
  },
  Grep: {
    schema: GrepSchema,
    description: GrepDescription.trim(),
    impl: grep as unknown as ToolImplementation,
  },
  KillBash: {
    schema: KillBashSchema,
    description: KillBashDescription.trim(),
    impl: kill_bash as unknown as ToolImplementation,
  },
  TaskOutput: {
    schema: TaskOutputSchema,
    description: TaskOutputDescription.trim(),
    impl: task_output as unknown as ToolImplementation,
  },
  TaskStop: {
    schema: TaskStopSchema,
    description: TaskStopDescription.trim(),
    impl: task_stop as unknown as ToolImplementation,
  },
  LS: {
    schema: LSSchema,
    description: LSDescription.trim(),
    impl: ls as unknown as ToolImplementation,
  },
  memory: {
    schema: MemorySchema,
    description: MemoryDescription.trim(),
    impl: memory as unknown as ToolImplementation,
  },
  memory_apply_patch: {
    schema: MemoryApplyPatchSchema,
    description: MemoryApplyPatchDescription.trim(),
    impl: memory_apply_patch as unknown as ToolImplementation,
  },
  MessageChannel: {
    schema: MessageChannelSchema,
    description: MessageChannelDescription.trim(),
    impl: message_channel as unknown as ToolImplementation,
  },
  MultiEdit: {
    schema: MultiEditSchema,
    description: MultiEditDescription.trim(),
    impl: multi_edit as unknown as ToolImplementation,
  },
  Read: {
    schema: ReadSchema,
    description: ReadDescription.trim(),
    impl: read as unknown as ToolImplementation,
  },
  view_image: {
    schema: ViewImageSchema,
    description: ViewImageDescription.trim(),
    impl: view_image as unknown as ToolImplementation,
  },
  ViewImage: {
    schema: ViewImageSchema,
    description: ViewImageDescription.trim(),
    impl: view_image as unknown as ToolImplementation,
  },
  // LSP-enhanced Read - used when LETTA_ENABLE_LSP is set
  ReadLSP: {
    schema: ReadLSPSchema,
    description: ReadLSPDescription.trim(),
    impl: read_lsp as unknown as ToolImplementation,
  },
  Skill: {
    schema: SkillSchema,
    description: SkillDescription.trim(),
    impl: skill as unknown as ToolImplementation,
  },
  Task: {
    schema: TaskSchema,
    description: TaskDescription.trim(),
    impl: task as unknown as ToolImplementation,
  },
  TodoWrite: {
    schema: TodoWriteSchema,
    description: TodoWriteDescription.trim(),
    impl: todo_write as unknown as ToolImplementation,
  },
  Write: {
    schema: WriteSchema,
    description: WriteDescription.trim(),
    impl: write as unknown as ToolImplementation,
  },
  shell_command: {
    schema: ShellCommandSchema,
    description: ShellCommandDescription.trim(),
    impl: shell_command as unknown as ToolImplementation,
  },
  exec_command: {
    schema: ExecCommandSchema,
    description: execCommandDescription(),
    impl: exec_command as unknown as ToolImplementation,
  },
  write_stdin: {
    schema: WriteStdinSchema,
    description: WriteStdinDescription.trim(),
    impl: write_stdin as unknown as ToolImplementation,
  },
  shell: {
    schema: ShellSchema,
    description: ShellDescription.trim(),
    impl: shell as unknown as ToolImplementation,
  },
  read_file: {
    schema: ReadFileCodexSchema,
    description: ReadFileCodexDescription.trim(),
    impl: read_file as unknown as ToolImplementation,
  },
  list_dir: {
    schema: ListDirCodexSchema,
    description: ListDirCodexDescription.trim(),
    impl: list_dir as unknown as ToolImplementation,
  },
  grep_files: {
    schema: GrepFilesSchema,
    description: GrepFilesDescription.trim(),
    impl: grep_files as unknown as ToolImplementation,
  },
  apply_patch: {
    schema: ApplyPatchSchema,
    description: ApplyPatchDescription.trim(),
    impl: apply_patch as unknown as ToolImplementation,
  },
  update_plan: {
    schema: UpdatePlanSchema,
    description: UpdatePlanDescription.trim(),
    impl: update_plan as unknown as ToolImplementation,
  },
  get_goal: {
    schema: GetGoalSchema,
    description: GetGoalDescription.trim(),
    impl: get_goal as unknown as ToolImplementation,
  },
  create_goal: {
    schema: CreateGoalSchema,
    description: CreateGoalDescription.trim(),
    impl: create_goal as unknown as ToolImplementation,
  },
  update_goal: {
    schema: UpdateGoalSchema,
    description: UpdateGoalDescription.trim(),
    impl: update_goal as unknown as ToolImplementation,
  },
  // Gemini toolset
  glob_gemini: {
    schema: GlobGeminiSchema,
    description: GlobGeminiDescription.trim(),
    impl: glob_gemini as unknown as ToolImplementation,
  },
  list_directory: {
    schema: ListDirectoryGeminiSchema,
    description: ListDirectoryGeminiDescription.trim(),
    impl: list_directory as unknown as ToolImplementation,
  },
  read_file_gemini: {
    schema: ReadFileGeminiSchema,
    description: ReadFileGeminiDescription.trim(),
    impl: read_file_gemini as unknown as ToolImplementation,
  },
  read_many_files: {
    schema: ReadManyFilesGeminiSchema,
    description: ReadManyFilesGeminiDescription.trim(),
    impl: read_many_files as unknown as ToolImplementation,
  },
  replace: {
    schema: ReplaceGeminiSchema,
    description: ReplaceGeminiDescription.trim(),
    impl: replace as unknown as ToolImplementation,
  },
  run_shell_command: {
    schema: RunShellCommandGeminiSchema,
    description: RunShellCommandGeminiDescription.trim(),
    impl: run_shell_command as unknown as ToolImplementation,
  },
  search_file_content: {
    schema: SearchFileContentGeminiSchema,
    description: SearchFileContentGeminiDescription.trim(),
    impl: search_file_content as unknown as ToolImplementation,
  },
  write_todos: {
    schema: WriteTodosGeminiSchema,
    description: WriteTodosGeminiDescription.trim(),
    impl: write_todos as unknown as ToolImplementation,
  },
  write_file_gemini: {
    schema: WriteFileGeminiSchema,
    description: WriteFileGeminiDescription.trim(),
    impl: write_file_gemini as unknown as ToolImplementation,
  },
  // Codex-2 toolset (PascalCase aliases for OpenAI tools)
  ShellCommand: {
    schema: ShellCommandSchema,
    description: ShellCommandDescription.trim(),
    impl: shell_command as unknown as ToolImplementation,
  },
  Shell: {
    schema: ShellSchema,
    description: ShellDescription.trim(),
    impl: shell as unknown as ToolImplementation,
  },
  ReadFile: {
    schema: ReadFileCodexSchema,
    description: ReadFileCodexDescription.trim(),
    impl: read_file as unknown as ToolImplementation,
  },
  ListDir: {
    schema: ListDirCodexSchema,
    description: ListDirCodexDescription.trim(),
    impl: list_dir as unknown as ToolImplementation,
  },
  GrepFiles: {
    schema: GrepFilesSchema,
    description: GrepFilesDescription.trim(),
    impl: grep_files as unknown as ToolImplementation,
  },
  ApplyPatch: {
    schema: ApplyPatchSchema,
    description: ApplyPatchDescription.trim(),
    impl: apply_patch as unknown as ToolImplementation,
  },
  UpdatePlan: {
    schema: UpdatePlanSchema,
    description: UpdatePlanDescription.trim(),
    impl: update_plan as unknown as ToolImplementation,
  },
  GetGoal: {
    schema: GetGoalSchema,
    description: GetGoalDescription.trim(),
    impl: get_goal as unknown as ToolImplementation,
  },
  CreateGoal: {
    schema: CreateGoalSchema,
    description: CreateGoalDescription.trim(),
    impl: create_goal as unknown as ToolImplementation,
  },
  UpdateGoal: {
    schema: UpdateGoalSchema,
    description: UpdateGoalDescription.trim(),
    impl: update_goal as unknown as ToolImplementation,
  },
  // Gemini-2 toolset (PascalCase aliases for Gemini tools)
  RunShellCommand: {
    schema: RunShellCommandGeminiSchema,
    description: RunShellCommandGeminiDescription.trim(),
    impl: run_shell_command as unknown as ToolImplementation,
  },
  ReadFileGemini: {
    schema: ReadFileGeminiSchema,
    description: ReadFileGeminiDescription.trim(),
    impl: read_file_gemini as unknown as ToolImplementation,
  },
  ListDirectory: {
    schema: ListDirectoryGeminiSchema,
    description: ListDirectoryGeminiDescription.trim(),
    impl: list_directory as unknown as ToolImplementation,
  },
  GlobGemini: {
    schema: GlobGeminiSchema,
    description: GlobGeminiDescription.trim(),
    impl: glob_gemini as unknown as ToolImplementation,
  },
  SearchFileContent: {
    schema: SearchFileContentGeminiSchema,
    description: SearchFileContentGeminiDescription.trim(),
    impl: search_file_content as unknown as ToolImplementation,
  },
  Replace: {
    schema: ReplaceGeminiSchema,
    description: ReplaceGeminiDescription.trim(),
    impl: replace as unknown as ToolImplementation,
  },
  WriteFileGemini: {
    schema: WriteFileGeminiSchema,
    description: WriteFileGeminiDescription.trim(),
    impl: write_file_gemini as unknown as ToolImplementation,
  },
  WriteTodos: {
    schema: WriteTodosGeminiSchema,
    description: WriteTodosGeminiDescription.trim(),
    impl: write_todos as unknown as ToolImplementation,
  },
  ReadManyFiles: {
    schema: ReadManyFilesGeminiSchema,
    description: ReadManyFilesGeminiDescription.trim(),
    impl: read_many_files as unknown as ToolImplementation,
  },
} as const satisfies Record<string, ToolAssets>;

export type ToolName = keyof typeof toolDefinitions;

export const TOOL_DEFINITIONS: Record<ToolName, ToolAssets> = toolDefinitions;
