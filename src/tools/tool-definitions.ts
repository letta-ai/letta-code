import { defineTool, type ToolAssets } from "./define-tool";
import ApplyPatchDescription from "./descriptions/ApplyPatch.md";
import AskUserQuestionDescription from "./descriptions/AskUserQuestion.md";
import BashDescription from "./descriptions/Bash.md";
import BashOutputDescription from "./descriptions/BashOutput.md";
import EditDescription from "./descriptions/Edit.md";
import EnterWorktreeDescription from "./descriptions/EnterWorktree.md";
import ExecCommandDescription from "./descriptions/ExecCommand.md";
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
import ReadArtifactFileDescription from "./descriptions/ReadArtifactFile.md";
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
import WriteFileGeminiDescription from "./descriptions/WriteFileGemini.md";
import WriteStdinDescription from "./descriptions/WriteStdin.md";
import WriteTodosGeminiDescription from "./descriptions/WriteTodosGemini.md";
import { apply_patch } from "./impl/apply-patch";
import { read_artifact_file, write_artifact_file } from "./impl/artifact-files";
import { ask_user_question } from "./impl/ask-user-question";
import { bash } from "./impl/bash";
import { bash_output } from "./impl/bash-output";
import { edit } from "./impl/edit";
import { enter_worktree } from "./impl/enter-worktree";
import { exec_command, write_stdin } from "./impl/exec-command";
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
import { write_file_gemini } from "./impl/write-file-gemini";
import { write_todos } from "./impl/write-todos-gemini";

import ApplyPatchSchema from "./schemas/ApplyPatch.json";
import AskUserQuestionSchema from "./schemas/AskUserQuestion.json";
import BashSchema from "./schemas/Bash.json";
import BashOutputSchema from "./schemas/BashOutput.json";
import EditSchema from "./schemas/Edit.json";
import EnterWorktreeSchema from "./schemas/EnterWorktree.json";
import ExecCommandSchema from "./schemas/ExecCommand.json";
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
import ReadArtifactFileSchema from "./schemas/ReadArtifactFile.json";
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
import WriteFileGeminiSchema from "./schemas/WriteFileGemini.json";
import WriteStdinSchema from "./schemas/WriteStdin.json";
import WriteTodosGeminiSchema from "./schemas/WriteTodosGemini.json";

const WINDOWS_UNIFIED_EXEC_GUIDANCE = `Windows safety rules:
- Do not compose destructive filesystem commands across shells. Do not enumerate paths in PowerShell and then pass them to \`cmd /c\`, batch builtins, or another shell for deletion or moving. Use one shell end-to-end, prefer native PowerShell cmdlets such as \`Remove-Item\` / \`Move-Item\` with \`-LiteralPath\`, and avoid string-built shell commands for file operations.
- Before any recursive delete or move on Windows, verify the resolved absolute target paths stay within the intended workspace or explicitly named target directory. Never issue a recursive delete or move against a computed path if the final target has not been checked.
- When using \`Start-Process\` to launch a background helper or service, pass \`-WindowStyle Hidden\` unless the user explicitly asked for a visible interactive window. Use visible windows only for interactive tools the user needs to see or control.`;

const WINDOWS_BASH_EXECUTION_GUIDANCE = `Windows execution:
- Despite the tool name, on Windows this tool does not run commands through bash by default. It uses the native Windows shell launcher: PowerShell Core (\`pwsh\`) when available, then Windows PowerShell, then \`cmd.exe\` as fallback.
- Write commands using PowerShell-compatible syntax by default. POSIX/bash constructs such as heredocs, \`export VAR=...\`, and Unix-style shell quoting may not work unless you explicitly invoke a POSIX shell.

${WINDOWS_UNIFIED_EXEC_GUIDANCE}`;

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
  MessageChannel: defineTool({
    schema: MessageChannelSchema,
    description: MessageChannelDescription.trim(),
    impl: message_channel,
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
  view_image: defineTool({
    schema: ViewImageSchema,
    description: ViewImageDescription.trim(),
    impl: view_image,
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
  apply_patch: defineTool({
    schema: ApplyPatchSchema,
    description: ApplyPatchDescription.trim(),
    impl: apply_patch,
  }),
  update_plan: defineTool({
    schema: UpdatePlanSchema,
    description: UpdatePlanDescription.trim(),
    impl: update_plan,
  }),
  // Gemini toolset
  glob_gemini: defineTool({
    schema: GlobGeminiSchema,
    description: GlobGeminiDescription.trim(),
    impl: glob_gemini,
  }),
  list_directory: defineTool({
    schema: ListDirectoryGeminiSchema,
    description: ListDirectoryGeminiDescription.trim(),
    impl: list_directory,
  }),
  read_file_gemini: defineTool({
    schema: ReadFileGeminiSchema,
    description: ReadFileGeminiDescription.trim(),
    impl: read_file_gemini,
  }),
  read_many_files: defineTool({
    schema: ReadManyFilesGeminiSchema,
    description: ReadManyFilesGeminiDescription.trim(),
    impl: read_many_files,
  }),
  replace: defineTool({
    schema: ReplaceGeminiSchema,
    description: ReplaceGeminiDescription.trim(),
    impl: replace,
  }),
  run_shell_command: defineTool({
    schema: RunShellCommandGeminiSchema,
    description: RunShellCommandGeminiDescription.trim(),
    impl: run_shell_command,
  }),
  search_file_content: defineTool({
    schema: SearchFileContentGeminiSchema,
    description: SearchFileContentGeminiDescription.trim(),
    impl: search_file_content,
  }),
  write_todos: defineTool({
    schema: WriteTodosGeminiSchema,
    description: WriteTodosGeminiDescription.trim(),
    impl: write_todos,
  }),
  write_file_gemini: defineTool({
    schema: WriteFileGeminiSchema,
    description: WriteFileGeminiDescription.trim(),
    impl: write_file_gemini,
  }),
  // Codex-2 toolset (PascalCase aliases for OpenAI tools)
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
  // Gemini-2 toolset (PascalCase aliases for Gemini tools)
  RunShellCommand: defineTool({
    schema: RunShellCommandGeminiSchema,
    description: RunShellCommandGeminiDescription.trim(),
    impl: run_shell_command,
  }),
  ReadFileGemini: defineTool({
    schema: ReadFileGeminiSchema,
    description: ReadFileGeminiDescription.trim(),
    impl: read_file_gemini,
  }),
  ListDirectory: defineTool({
    schema: ListDirectoryGeminiSchema,
    description: ListDirectoryGeminiDescription.trim(),
    impl: list_directory,
  }),
  GlobGemini: defineTool({
    schema: GlobGeminiSchema,
    description: GlobGeminiDescription.trim(),
    impl: glob_gemini,
  }),
  SearchFileContent: defineTool({
    schema: SearchFileContentGeminiSchema,
    description: SearchFileContentGeminiDescription.trim(),
    impl: search_file_content,
  }),
  Replace: defineTool({
    schema: ReplaceGeminiSchema,
    description: ReplaceGeminiDescription.trim(),
    impl: replace,
  }),
  WriteFileGemini: defineTool({
    schema: WriteFileGeminiSchema,
    description: WriteFileGeminiDescription.trim(),
    impl: write_file_gemini,
  }),
  WriteTodos: defineTool({
    schema: WriteTodosGeminiSchema,
    description: WriteTodosGeminiDescription.trim(),
    impl: write_todos,
  }),
  ReadManyFiles: defineTool({
    schema: ReadManyFilesGeminiSchema,
    description: ReadManyFilesGeminiDescription.trim(),
    impl: read_many_files,
  }),
} as const satisfies Record<string, ToolAssets>;

export type ToolName = keyof typeof toolDefinitions;

export const TOOL_DEFINITIONS: Record<ToolName, ToolAssets> = toolDefinitions;
