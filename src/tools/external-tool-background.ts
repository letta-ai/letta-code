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
type Settled<T> =
  | { kind: "result"; result: T }
  | { kind: "error"; error: unknown };

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
    scope?: NotificationScope;
    runtimeScope?: {
      agentId?: string | null;
      conversationId?: string | null;
      actingUserId?: string;
    };
    canBackground?: boolean;
    enqueue?: (message: QueuedMessage) => void;
  },
): Promise<T | { status: "success"; toolReturn: string }> {
  const runtime = options?.runtimeScope;
  const scope =
    options?.scope ??
    (runtime?.agentId && runtime.conversationId
      ? {
          agentId: runtime.agentId,
          conversationId: runtime.conversationId,
          actingUserId: runtime.actingUserId,
        }
      : undefined);
  // Only listener tools opt in. Headless SDK tools share one stdin reader, and
  // tool_end mods must see the real result before the model does.
  if (
    tool?.autoBackground !== true ||
    options?.canBackground === false ||
    !scope ||
    (!options?.enqueue && !isQueueBridgeConnected())
  )
    return operation;

  const startedAt = Date.now();
  const settled: Promise<Settled<T>> = operation.then(
    (result) => ({ kind: "result", result }),
    (error: unknown) => ({ kind: "error", error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([
    settled,
    new Promise<{ kind: "yield" }>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: "yield" }),
        options?.yieldMs ?? DEFAULT_EXTERNAL_TOOL_YIELD_MS,
      );
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (first.kind === "result") return first.result;
  if (first.kind === "error") throw first.error;

  const taskId = `external_${crypto.randomUUID()}`;
  const enqueue = options?.enqueue ?? addToMessageQueue;
  void settled.then((outcome) => {
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
