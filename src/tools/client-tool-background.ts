import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ModEvents } from "@/mods/event-emitter";
import { runWithRuntimeContext } from "@/runtime-context";
import { autoBackgroundExternalTool } from "@/tools/external-tool-background";

// File edits include memory-file edits. These state changes must finish before
// the next call in a batch can observe the changed file, plan, task, or cwd.
const FOREGROUND_TOOLS = new Set([
  "Edit",
  "Write",
  "ApplyPatch",
  "write_artifact_file",
  "SetWorkingDirectory",
  "EnterWorktree",
  "ExitWorktree",
  "UpdatePlan",
  "TaskCreate",
  "TaskUpdate",
  "AskUserQuestionAsync",
]);
const SELF_BACKGROUNDING_TOOLS = new Set(["Bash", "exec_command", "CodeMode"]);

type BackgroundOptions = NonNullable<
  Parameters<typeof autoBackgroundExternalTool>[3]
>;

/** Called only after approval/permission checks, so human wait time is excluded. */
export function autoBackgroundClientTool<
  T extends {
    status: "success" | "error";
    toolReturn: MessageCreate["content"];
  },
>(
  name: string,
  operation: Promise<T>,
  options: BackgroundOptions,
  events?: ModEvents,
) {
  if (FOREGROUND_TOOLS.has(name) || SELF_BACKGROUNDING_TOOLS.has(name))
    return operation;
  return runWithRuntimeContext(options.runtimeScope ?? {}, () =>
    autoBackgroundExternalTool(name, { autoBackground: true }, operation, {
      ...options,
      clientTool: true,
      canBackground: () =>
        !events || events.hasHandlers?.("tool_end") === false,
    }),
  );
}
