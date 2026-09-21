import { telemetry } from "@/telemetry";
import { messageChannelTelemetry } from "@/telemetry/channel";
import { normalizeExternalToolResultContent } from "./external-tool-content";
import { clampToolReturnContent } from "./impl/tool-return-clamp";

/** Execute a controller-owned tool while preserving cancellation and returns. */
export async function runExternalTool<T>(params: {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  tool?: T;
  signal?: AbortSignal;
  executor?: (
    id: string,
    name: string,
    input: Record<string, unknown>,
    context?: { tool: T; signal?: AbortSignal },
  ) => Promise<{
    content: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    isError: boolean;
  }>;
}): Promise<{
  toolReturn: ReturnType<typeof normalizeExternalToolResultContent>;
  status: "success" | "error";
}> {
  const { toolCallId, toolName, input, executor, tool, signal } = params;
  if (!executor)
    return {
      toolReturn: `External tool executor not set for tool: ${toolName}`,
      status: "error",
    };
  const startedAt = Date.now();
  let success = false;
  try {
    signal?.throwIfAborted();
    const result = await executor(
      toolCallId,
      toolName,
      input,
      tool ? { tool, signal } : undefined,
    );
    success = !result.isError;
    return {
      toolReturn: clampToolReturnContent(
        normalizeExternalToolResultContent(result.content),
        toolName,
      ),
      status: result.isError ? "error" : "success",
    };
  } catch (error) {
    return {
      toolReturn: `External tool execution error: ${error instanceof Error ? error.message : String(error)}`,
      status: "error",
    };
  } finally {
    if (toolName === "MessageChannel" || toolName === "message_channel") {
      telemetry.trackToolUsage(
        toolName,
        success,
        Date.now() - startedAt,
        undefined,
        success ? undefined : "tool_error",
        undefined,
        messageChannelTelemetry(input),
      );
    }
  }
}
