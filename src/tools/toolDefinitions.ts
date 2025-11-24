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
import TaskDescription from "./descriptions/Task.md";
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
import { task } from "./impl/Task";
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
import TaskSchema from "./schemas/Task.json";
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
} as const satisfies Record<string, ToolAssets>;

export type ToolName = keyof typeof toolDefinitions;

export const TOOL_DEFINITIONS: Record<ToolName, ToolAssets> = toolDefinitions;
