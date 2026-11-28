import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { resolveForegroundYieldMs } from "@/tools/foreground-yield";
import {
  appendToOutputFile,
  type BackgroundProcess,
  backgroundProcesses,
  createBackgroundOutputFile,
  notifyBackgroundProcessStateChanged,
  scheduleBackgroundProcessCleanup,
} from "@/tools/impl/process_manager";
import { LIMITS, truncateByChars } from "@/tools/impl/truncation";
import { scrubAmbientSecrets } from "@/tools/secret-substitution";
import {
  addToMessageQueue,
  isQueueBridgeConnected,
  type QueuedMessage,
} from "@/utils/message-queue-bridge";
import {
  formatMultimodalTaskNotification,
  formatTaskNotification,
  type NotificationScope,
} from "@/utils/task-notifications";

type ExternalResult = {
  status: "success" | "error";
  toolReturn: MessageCreate["content"];
  cancellation?: "cancelled" | "timeout";
};
export type InterruptedExternalResult = {
  status: "error";
  toolReturn: string;
};
type Settled<T> =
  | { kind: "result"; result: T }
  | { kind: "error"; error: unknown };

export function interruptedExternalToolResult(
  toolName: string,
): InterruptedExternalResult {
  return {
    status: "error",
    toolReturn: `Tool call interrupted by user: ${toolName}. The remote tool may still finish; its outcome is unknown. Check the destination before retrying a write.`,
  };
}

function raceExternalOperationAbort<T extends ExternalResult>(
  operation: Promise<T>,
  signal: AbortSignal,
  toolName: string,
): Promise<T | InterruptedExternalResult> {
  if (signal.aborted) {
    return Promise.resolve(interruptedExternalToolResult(toolName));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      resolve(interruptedExternalToolResult(toolName));
    };
    signal.addEventListener("abort", onAbort);
    operation.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function notificationText(toolReturn: unknown): string {
  return scrubAmbientSecrets(String(toolReturn));
}

export async function autoBackgroundExternalTool<T extends ExternalResult>(
  toolName: string,
  tool: { autoBackground?: boolean } | undefined,
  operation: Promise<T>,
  options?: {
    abortController?: AbortController;
    remoteAbortController?: AbortController;
    onBackground?: (outputFile: string) => void;
    yieldMs?: number;
    signal?: AbortSignal;
    scope?: NotificationScope;
    runtimeScope?: {
      agentId?: string | null;
      conversationId?: string | null;
      actingUserId?: string;
      suppressActingUserFallback?: boolean;
    };
    canBackground?: boolean | (() => boolean);
    enqueue?: (message: QueuedMessage) => void;
    shouldEnqueue?: () => boolean | Promise<boolean>;
  },
): Promise<
  T | { status: "success"; toolReturn: string } | InterruptedExternalResult
> {
  const signal = options?.signal;
  const runtime = options?.runtimeScope;
  const scope =
    options?.scope ??
    (runtime?.agentId && runtime.conversationId
      ? {
          agentId: runtime.agentId,
          conversationId: runtime.conversationId,
          actingUserId: runtime.suppressActingUserFallback
            ? null
            : runtime.actingUserId,
        }
      : undefined);
  const canBackground = () =>
    typeof options?.canBackground === "function"
      ? options.canBackground()
      : options?.canBackground !== false;
  if (
    tool?.autoBackground !== true ||
    !canBackground() ||
    !scope ||
    (!options?.enqueue && !isQueueBridgeConnected())
  )
    return signal && !options?.abortController
      ? raceExternalOperationAbort(operation, signal, toolName)
      : operation;

  const startedAt = Date.now();
  const settled: Promise<Settled<T>> = operation.then(
    (result) => ({ kind: "result", result }),
    (error: unknown) => ({ kind: "error", error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const abortSettled = signal
    ? new Promise<{ kind: "aborted" }>((resolve) => {
        onAbort = () => resolve({ kind: "aborted" });
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort);
      })
    : undefined;
  const first = await Promise.race([
    settled,
    new Promise<{ kind: "yield" }>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: "yield" }),
        options?.yieldMs ?? resolveForegroundYieldMs(),
      );
    }),
    ...(abortSettled ? [abortSettled] : []),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (onAbort !== undefined && signal) {
    signal.removeEventListener("abort", onAbort);
  }
  if (first.kind === "aborted")
    return options?.abortController
      ? operation
      : interruptedExternalToolResult(toolName);
  if (first.kind === "result") return first.result;
  if (first.kind === "error") throw first.error;
  if (!canBackground()) {
    return signal && !options?.abortController
      ? raceExternalOperationAbort(operation, signal, toolName)
      : operation;
  }

  const taskId = `external_${crypto.randomUUID()}`;
  const outputFile = createBackgroundOutputFile(taskId);
  const entry: BackgroundProcess = {
    process: { kill: () => options?.abortController?.abort() },
    command: toolName,
    description: `Tool ${toolName}`,
    kind: "tool",
    remote: !options?.abortController,
    status: "running",
    exitCode: null,
    startTime: new Date(startedAt),
    outputFile,
    runtimeScope: scope,
    actingUserId: scope.actingUserId,
    ...(options?.remoteAbortController
      ? {
          cancel: async () => {
            options.remoteAbortController?.abort();
            const outcome = await settled;
            if (
              outcome.kind === "result" &&
              outcome.result.cancellation === "cancelled"
            ) {
              return { killed: true, output: "Stopped" };
            }
            if (
              outcome.kind === "error" ||
              outcome.result.cancellation === "timeout"
            ) {
              return {
                killed: false,
                output:
                  "Cancellation was not confirmed; the remote tool may still finish.",
              };
            }
            return {
              killed: false,
              output: `Already finished: ${notificationText(outcome.result.toolReturn)}`,
            };
          },
        }
      : {}),
  };
  backgroundProcesses.set(taskId, entry);
  options?.onBackground?.(outputFile);
  notifyBackgroundProcessStateChanged(scope);
  const enqueue = options?.enqueue ?? addToMessageQueue;
  void settled.then(async (outcome) => {
    const result = outcome.kind === "result" ? outcome.result : undefined;
    const status = result?.status === "success" ? "completed" : "failed";
    const richContent = Array.isArray(result?.toolReturn)
      ? result.toolReturn.map((part) =>
          part.type === "text"
            ? { ...part, text: scrubAmbientSecrets(part.text) }
            : part,
        )
      : undefined;
    let raw = result
      ? richContent
        ? "See the attached tool result."
        : notificationText(result.toolReturn)
      : scrubAmbientSecrets(
          String(outcome.kind === "error" ? outcome.error : "Unknown error"),
        );
    if (
      !options?.abortController &&
      status === "failed" &&
      (!result ||
        (typeof result.toolReturn === "string" &&
          result.toolReturn.startsWith("External tool execution error:"))) &&
      !raw.includes("outcome is unknown")
    ) {
      raw +=
        " The remote tool may still finish; its outcome is unknown. Check the destination before retrying a write.";
    }
    if (
      status === "failed" &&
      raw.startsWith("External tool execution error:")
    ) {
      raw = raw.replace(
        /^External tool execution error:/,
        "Tool execution error:",
      );
    }
    appendToOutputFile(
      outputFile,
      richContent
        ? `${richContent
            .map((part) =>
              part.type === "text"
                ? part.text
                : "[Image result; see completion notification]",
            )
            .join("\n")}\n`
        : `${raw}\n`,
    );
    if (!entry.completionNotificationSuppressed) {
      entry.status = status;
      entry.exitCode = status === "completed" ? 0 : 1;
    }
    scheduleBackgroundProcessCleanup(taskId);
    notifyBackgroundProcessStateChanged(scope);
    if (
      entry.completionNotificationSuppressed ||
      (await options?.shouldEnqueue?.()) === false
    )
      return;
    const content = truncateByChars(
      raw,
      LIMITS.TOOL_RETURN_MAX_CHARS + 1_000,
      toolName,
    );
    const notification = {
      taskId,
      status,
      summary: `Tool ${toolName} ${status}`,
      usage: { durationMs: Date.now() - startedAt },
    } as const;
    enqueue({
      kind: "task_notification",
      text: formatTaskNotification({
        ...notification,
        result: content.content,
      }),
      ...(richContent
        ? {
            content: formatMultimodalTaskNotification(
              notification,
              richContent,
            ),
          }
        : {}),
      ...scope,
    });
  });

  return {
    status: "success",
    toolReturn: `Tool ${toolName} is still running with task ID: ${taskId}\nOutput file: ${outputFile}\nYou will be notified when it completes.`,
  };
}
