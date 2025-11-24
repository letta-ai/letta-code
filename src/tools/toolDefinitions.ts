import ApplyPatchDescription from "./descriptions/ApplyPatch.md";
import BashDescription from "./descriptions/Bash.md";
import BashOutputDescription from "./descriptions/BashOutput.md";
import EditDescription from "./descriptions/Edit.md";
import ExitPlanModeDescription from "./descriptions/ExitPlanMode.md";
import GlobDescription from "./descriptions/Glob.md";
// Gemini toolset
import GlobGeminiDescription from "./descriptions/GlobGemini.md";
import GrepDescription from "./descriptions/Grep.md";
import GrepFilesDescription from "./descriptions/GrepFiles.md";
import KillBashDescription from "./descriptions/KillBash.md";
import ListDirCodexDescription from "./descriptions/ListDirCodex.md";
import ListDirectoryGeminiDescription from "./descriptions/ListDirectoryGemini.md";
import LSDescription from "./descriptions/LS.md";
import MultiEditDescription from "./descriptions/MultiEdit.md";
import ReadDescription from "./descriptions/Read.md";
import ReadFileCodexDescription from "./descriptions/ReadFileCodex.md";
import ReadFileGeminiDescription from "./descriptions/ReadFileGemini.md";
import ReadManyFilesGeminiDescription from "./descriptions/ReadManyFilesGemini.md";
import ReplaceGeminiDescription from "./descriptions/ReplaceGemini.md";
import RunShellCommandGeminiDescription from "./descriptions/RunShellCommandGemini.md";
import SearchFileContentGeminiDescription from "./descriptions/SearchFileContentGemini.md";
import ShellDescription from "./descriptions/Shell.md";
import ShellCommandDescription from "./descriptions/ShellCommand.md";
import TodoWriteDescription from "./descriptions/TodoWrite.md";
import UpdatePlanDescription from "./descriptions/UpdatePlan.md";
import WriteDescription from "./descriptions/Write.md";
import WriteFileGeminiDescription from "./descriptions/WriteFileGemini.md";
import WriteTodosGeminiDescription from "./descriptions/WriteTodosGemini.md";
import { apply_patch } from "./impl/ApplyPatch";
import { bash } from "./impl/Bash";
import { bash_output } from "./impl/BashOutput";
import { edit } from "./impl/Edit";
import { exit_plan_mode } from "./impl/ExitPlanMode";
import { glob } from "./impl/Glob";
// Gemini toolset
import { glob_gemini } from "./impl/GlobGemini";
import { grep } from "./impl/Grep";
import { grep_files } from "./impl/GrepFiles";
import { kill_bash } from "./impl/KillBash";
import { list_dir } from "./impl/ListDirCodex";
import { list_directory } from "./impl/ListDirectoryGemini";
import { ls } from "./impl/LS";
import { multi_edit } from "./impl/MultiEdit";
import { read } from "./impl/Read";
import { read_file } from "./impl/ReadFileCodex";
import { read_file_gemini } from "./impl/ReadFileGemini";
import { read_many_files } from "./impl/ReadManyFilesGemini";
import { replace } from "./impl/ReplaceGemini";
import { run_shell_command } from "./impl/RunShellCommandGemini";
import { search_file_content } from "./impl/SearchFileContentGemini";
import { shell } from "./impl/Shell";
import { shell_command } from "./impl/ShellCommand";
import { todo_write } from "./impl/TodoWrite";
import { update_plan } from "./impl/UpdatePlan";
import { write } from "./impl/Write";
import { write_file_gemini } from "./impl/WriteFileGemini";
import { write_todos } from "./impl/WriteTodosGemini";
import ApplyPatchSchema from "./schemas/ApplyPatch.json";
import BashSchema from "./schemas/Bash.json";
import BashOutputSchema from "./schemas/BashOutput.json";
import EditSchema from "./schemas/Edit.json";
import ExitPlanModeSchema from "./schemas/ExitPlanMode.json";
import GlobSchema from "./schemas/Glob.json";
// Gemini toolset
import GlobGeminiSchema from "./schemas/GlobGemini.json";
import GrepSchema from "./schemas/Grep.json";
import GrepFilesSchema from "./schemas/GrepFiles.json";
import KillBashSchema from "./schemas/KillBash.json";
import ListDirCodexSchema from "./schemas/ListDirCodex.json";
import ListDirectoryGeminiSchema from "./schemas/ListDirectoryGemini.json";
import LSSchema from "./schemas/LS.json";
import MultiEditSchema from "./schemas/MultiEdit.json";
import ReadSchema from "./schemas/Read.json";
import ReadFileCodexSchema from "./schemas/ReadFileCodex.json";
import ReadFileGeminiSchema from "./schemas/ReadFileGemini.json";
import ReadManyFilesGeminiSchema from "./schemas/ReadManyFilesGemini.json";
import ReplaceGeminiSchema from "./schemas/ReplaceGemini.json";
import RunShellCommandGeminiSchema from "./schemas/RunShellCommandGemini.json";
import SearchFileContentGeminiSchema from "./schemas/SearchFileContentGemini.json";
import ShellSchema from "./schemas/Shell.json";
import ShellCommandSchema from "./schemas/ShellCommand.json";
import TodoWriteSchema from "./schemas/TodoWrite.json";
import UpdatePlanSchema from "./schemas/UpdatePlan.json";
import WriteSchema from "./schemas/Write.json";
import WriteFileGeminiSchema from "./schemas/WriteFileGemini.json";
import WriteTodosGeminiSchema from "./schemas/WriteTodosGemini.json";

type ToolImplementation = (args: Record<string, unknown>) => Promise<unknown>;

interface ToolAssets {
  schema: Record<string, unknown>;
  description: string;
  impl: ToolImplementation;
}

const toolDefinitions = {
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
  Edit: {
    schema: EditSchema,
    description: EditDescription.trim(),
    impl: edit as unknown as ToolImplementation,
  },
  ExitPlanMode: {
    schema: ExitPlanModeSchema,
    description: ExitPlanModeDescription.trim(),
    impl: exit_plan_mode as unknown as ToolImplementation,
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
  LS: {
    schema: LSSchema,
    description: LSDescription.trim(),
    impl: ls as unknown as ToolImplementation,
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
} as const satisfies Record<string, ToolAssets>;

export type ToolName = keyof typeof toolDefinitions;

export const TOOL_DEFINITIONS: Record<ToolName, ToolAssets> = toolDefinitions;
