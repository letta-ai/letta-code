import BashDescription from "./descriptions/Bash.md";
import BashOutputDescription from "./descriptions/BashOutput.md";
import EditDescription from "./descriptions/Edit.md";
import ExitPlanModeDescription from "./descriptions/ExitPlanMode.md";
import GlobDescription from "./descriptions/Glob.md";
import GrepDescription from "./descriptions/Grep.md";
import KillBashDescription from "./descriptions/KillBash.md";
import LSDescription from "./descriptions/LS.md";
import MultiEditDescription from "./descriptions/MultiEdit.md";
import ReadDescription from "./descriptions/Read.md";
import TodoWriteDescription from "./descriptions/TodoWrite.md";
import WriteDescription from "./descriptions/Write.md";
import { bash } from "./impl/Bash";
import { bash_output } from "./impl/BashOutput";
import { edit } from "./impl/Edit";
import { exit_plan_mode } from "./impl/ExitPlanMode";
import { glob } from "./impl/Glob";
import { grep } from "./impl/Grep";
import { kill_bash } from "./impl/KillBash";
import { ls } from "./impl/LS";
import { multi_edit } from "./impl/MultiEdit";
import { read } from "./impl/Read";
import { todo_write } from "./impl/TodoWrite";
import { write } from "./impl/Write";
import BashSchema from "./schemas/Bash.json";
import BashOutputSchema from "./schemas/BashOutput.json";
import EditSchema from "./schemas/Edit.json";
import ExitPlanModeSchema from "./schemas/ExitPlanMode.json";
import GlobSchema from "./schemas/Glob.json";
import GrepSchema from "./schemas/Grep.json";
import KillBashSchema from "./schemas/KillBash.json";
import LSSchema from "./schemas/LS.json";
import MultiEditSchema from "./schemas/MultiEdit.json";
import ReadSchema from "./schemas/Read.json";
import TodoWriteSchema from "./schemas/TodoWrite.json";
import WriteSchema from "./schemas/Write.json";

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
    impl: bash,
  },
  BashOutput: {
    schema: BashOutputSchema,
    description: BashOutputDescription.trim(),
    impl: bash_output,
  },
  Edit: {
    schema: EditSchema,
    description: EditDescription.trim(),
    impl: edit,
  },
  ExitPlanMode: {
    schema: ExitPlanModeSchema,
    description: ExitPlanModeDescription.trim(),
    impl: exit_plan_mode,
  },
  Glob: {
    schema: GlobSchema,
    description: GlobDescription.trim(),
    impl: glob,
  },
  Grep: {
    schema: GrepSchema,
    description: GrepDescription.trim(),
    impl: grep,
  },
  KillBash: {
    schema: KillBashSchema,
    description: KillBashDescription.trim(),
    impl: kill_bash,
  },
  LS: {
    schema: LSSchema,
    description: LSDescription.trim(),
    impl: ls,
  },
  MultiEdit: {
    schema: MultiEditSchema,
    description: MultiEditDescription.trim(),
    impl: multi_edit,
  },
  Read: {
    schema: ReadSchema,
    description: ReadDescription.trim(),
    impl: read,
  },
  TodoWrite: {
    schema: TodoWriteSchema,
    description: TodoWriteDescription.trim(),
    impl: todo_write,
  },
  Write: {
    schema: WriteSchema,
    description: WriteDescription.trim(),
    impl: write,
  },
} as const satisfies Record<string, ToolAssets>;

export type ToolName = keyof typeof toolDefinitions;

export const TOOL_DEFINITIONS: Record<ToolName, ToolAssets> = toolDefinitions;
