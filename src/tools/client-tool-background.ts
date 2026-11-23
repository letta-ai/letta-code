import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ModEvents } from "@/mods/event-emitter";
import { runWithRuntimeContext } from "@/runtime-context";
import { autoBackgroundExternalTool } from "@/tools/external-tool-background";
import { appendToOutputFile } from "@/tools/impl/process_manager";
import { scrubAmbientSecrets } from "@/tools/secret-substitution";

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

export const FOREGROUND_TOOL_TIMEOUT_MS = 10_000;
export const WORKTREE_TOOL_TIMEOUT_MS = 60_000;
const UNCAPPED_FOREGROUND_TOOLS = new Set(["AskUserQuestionAsync"]);
const WORKTREE_TOOLS = new Set(["EnterWorktree", "ExitWorktree"]);

export function foregroundToolTimeoutMs(name: string): number | undefined {
  if (!FOREGROUND_TOOLS.has(name) || UNCAPPED_FOREGROUND_TOOLS.has(name))
    return undefined;
  return WORKTREE_TOOLS.has(name)
    ? WORKTREE_TOOL_TIMEOUT_MS
    : FOREGROUND_TOOL_TIMEOUT_MS;
}

function foregroundTimeoutMessage(name: string, timeoutMs: number): string {
  return `${name} did not finish within ${timeoutMs / 1000}s and was abandoned. Its change may still have been applied; re-read the affected file or state before retrying.`;
}

function withForegroundTimeout<T extends { status: "success" | "error" }>(
  name: string,
  pending: Promise<T>,
  controller: AbortController,
): Promise<T | { status: "error"; toolReturn: string }> {
  const timeoutMs = foregroundToolTimeoutMs(name);
  if (timeoutMs === undefined) return pending;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ status: "error"; toolReturn: string }>(
    (resolve) => {
      timer = setTimeout(() => {
        const toolReturn = foregroundTimeoutMessage(name, timeoutMs);
        controller.abort(new Error(toolReturn));
        resolve({ status: "error", toolReturn });
      }, timeoutMs);
    },
  );
  pending.catch(() => {});
  return Promise.race([pending, timedOut]).finally(() => clearTimeout(timer));
}

type BackgroundOptions = NonNullable<
  Parameters<typeof autoBackgroundExternalTool>[3]
>;

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
  if (FOREGROUND_TOOLS.has(name))
    return withForegroundTimeout(name, pending, controller);
  if (SELF_BACKGROUNDING_TOOLS.has(name)) return pending;
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
