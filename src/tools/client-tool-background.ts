import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ModEvents } from "@/mods/event-emitter";
import { runWithRuntimeContext } from "@/runtime-context";
import { autoBackgroundExternalTool } from "@/tools/external-tool-background";
import { appendToOutputFile } from "@/tools/impl/process_manager";
import { scrubAmbientSecrets } from "@/tools/secret-substitution";

// File edits include memory-file edits. These state changes must finish before
// the next call in a batch can observe the changed file, plan, task, or cwd.
const FOREGROUND_TOOLS = new Set([
  "Edit",
  "Memory",
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
  operation:
    | Promise<T>
    | ((
        signal: AbortSignal,
        onOutput: (chunk: string, stream: "stdout" | "stderr") => void,
      ) => Promise<T>),
  options: BackgroundOptions & {
    onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  },
  events?: ModEvents,
) {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  let outputFile: string | undefined;
  const onOutput = (chunk: string, stream: "stdout" | "stderr") => {
    options.onOutput?.(chunk, stream);
    if (outputFile) appendToOutputFile(outputFile, scrubAmbientSecrets(chunk));
  };
  const pending = (
    typeof operation === "function"
      ? operation(controller.signal, onOutput)
      : operation
  ).finally(() => options.signal?.removeEventListener("abort", abort));
  if (FOREGROUND_TOOLS.has(name) || SELF_BACKGROUNDING_TOOLS.has(name))
    return pending;
  return runWithRuntimeContext(options.runtimeScope ?? {}, () =>
    autoBackgroundExternalTool(name, { autoBackground: true }, pending, {
      ...options,
      signal: controller.signal,
      abortController: controller,
      onBackground: (file) => {
        outputFile = file;
      },
      canBackground: () =>
        !events || events.hasHandlers?.("tool_end") === false,
    }),
  );
}
