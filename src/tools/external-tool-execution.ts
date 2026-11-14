import { getRuntimeContext } from "@/runtime-context";
import { telemetry } from "@/telemetry";
import { messageChannelTelemetry } from "@/telemetry/channel";
import { normalizeExternalToolResultContent } from "@/tools/external-tool-content";
import type {
  ExternalToolDefinition,
  ExternalToolExecutor,
} from "@/tools/external-tool-types";
import { clampToolReturnContent } from "@/tools/impl/tool-return-clamp";

/** Execute one dispatched request; registry ownership remains with the manager. */
export async function executeExternalToolRequest(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  executorOverride?: ExternalToolExecutor,
  toolDefinition?: ExternalToolDefinition,
  signal?: AbortSignal,
): Promise<{
  status: "success" | "error";
  cancellation?: "cancelled" | "timeout";
  toolReturn: ReturnType<typeof clampToolReturnContent>;
}> {
  const executor = executorOverride;
  if (!executor) {
    return {
      toolReturn: `External tool executor not set for tool: ${toolName}`,
      status: "error",
    };
  }

  const startedAt = Date.now();
  let success = false;
  try {
    const tool = toolDefinition;
    const result = await executor(
      toolCallId,
      toolName,
      input,
      tool
        ? { tool, signal, turnStartedAt: getRuntimeContext()?.turnStartedAt }
        : undefined,
    );
    success = !result.isError;
    return {
      toolReturn: clampToolReturnContent(
        normalizeExternalToolResultContent(result.content),
        toolName,
      ),
      status: result.isError ? "error" : "success",
      ...(result.cancellation ? { cancellation: result.cancellation } : {}),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      toolReturn: `External tool execution error: ${errorMessage}`,
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
