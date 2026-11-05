import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { LIMITS, truncateByChars } from "@/tools/impl/truncation";
import { scrubAmbientSecrets } from "@/tools/secret-substitution";
import {
  addToMessageQueue,
  isQueueBridgeConnected,
  type QueuedMessage,
} from "@/utils/message-queue-bridge";
import {
  formatTaskNotification,
  type NotificationScope,
} from "@/utils/task-notifications";

// Match exec_command's default foreground yield. The listener's timeout_ms
// remains the separate, total deadline for the remote result.
export const DEFAULT_EXTERNAL_TOOL_YIELD_MS = 10_000;

type ExternalResult = {
  status: "success" | "error";
  toolReturn: MessageCreate["content"];
};
/** An external tool unwound early because the turn's abort signal fired. */
export type InterruptedExternalResult = {
  status: "error";
  toolReturn: string;
};
type Settled<T> =
  | { kind: "result"; result: T }
  | { kind: "error"; error: unknown };

/**
 * Build the fulfilled error result for an external tool whose turn was
 * cancelled mid-flight. Mirrors the bridge-timeout wording: the remote tool
 * was already dispatched and may still take effect, so the model must not
 * assume the call was rolled back.
 */
export function interruptedExternalToolResult(
  toolName: string,
): InterruptedExternalResult {
  return {
    status: "error",
    toolReturn: `External tool call interrupted by user: ${toolName}. The remote tool may still finish; its outcome is unknown. Check the destination before retrying a write.`,
  };
}

/**
 * Settle a blocking external-tool operation when the turn's abort signal
 * fires so a cancelled turn stops waiting for the remote result. The
 * underlying operation keeps running; once the turn is unwound its eventual
 * result has no consumer (the notification path is only wired after a
 * yield), so it is dropped rather than surfaced.
 */
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

/** Yield an external result as a scoped notification without starting a second request. */
export async function autoBackgroundExternalTool<T extends ExternalResult>(
  toolName: string,
  tool: { autoBackground?: boolean } | undefined,
  operation: Promise<T>,
  options?: {
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
  // Only listener tools opt in. Headless SDK tools share one stdin reader, and
  // tool_end mods must see the real result before the model does.
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
    return signal
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
        signal?.addEventListener("abort", onAbort);
      })
    : undefined;
  const first = await Promise.race([
    settled,
    new Promise<{ kind: "yield" }>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: "yield" }),
        options?.yieldMs ?? DEFAULT_EXTERNAL_TOOL_YIELD_MS,
      );
    }),
    ...(abortSettled ? [abortSettled] : []),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (onAbort !== undefined && signal) {
    signal.removeEventListener("abort", onAbort);
  }
  if (first.kind === "aborted") return interruptedExternalToolResult(toolName);
  if (first.kind === "result") return first.result;
  if (first.kind === "error") throw first.error;
  // A mod may reload while the operation is in the foreground window.
  // If a tool_end handler became active, wait for the real result inline.
  if (!canBackground()) {
    return signal
      ? raceExternalOperationAbort(operation, signal, toolName)
      : operation;
  }

  const taskId = `external_${crypto.randomUUID()}`;
  const enqueue = options?.enqueue ?? addToMessageQueue;
  void settled.then(async (outcome) => {
    if ((await options?.shouldEnqueue?.()) === false) return;
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
        ? "The tool result follows this notification as text and image parts."
        : notificationText(result.toolReturn)
      : scrubAmbientSecrets(
          String(outcome.kind === "error" ? outcome.error : "Unknown error"),
        );
    if (
      status === "failed" &&
      (!result ||
        (typeof result.toolReturn === "string" &&
          result.toolReturn.startsWith("External tool execution error:"))) &&
      !raw.includes("outcome is unknown")
    ) {
      raw +=
        " The remote tool may still finish; its outcome is unknown. Check the destination before retrying a write.";
    }
    // executeExternalTool has already clamped the result to 32K plus an
    // overflow-file notice. A smaller notification cap would hide that path.
    const content = truncateByChars(
      raw,
      LIMITS.TOOL_RETURN_MAX_CHARS + 1_000,
      toolName,
    );
    enqueue({
      kind: "task_notification",
      text: formatTaskNotification({
        taskId,
        status,
        summary: `External tool ${toolName} ${status}`,
        result: content.content,
        usage: { durationMs: Date.now() - startedAt },
      }),
      ...(richContent ? { content: richContent } : {}),
      ...scope,
    });
  });

  return {
    status: "success",
    toolReturn: `External tool ${toolName} is still running. Task ID: ${taskId}. Its completion will arrive as a task notification. Do not retry an in-flight write or use this task ID as its result. A remote write cannot be cancelled by TaskStop.`,
  };
}
