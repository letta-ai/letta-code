import {
  getCurrentWorkingDirectory,
  getRuntimeContext,
} from "@/runtime-context";
import { telemetry } from "@/telemetry";
import { reportDiskFullIfDetected } from "@/telemetry/sandbox-failure-reporting";

/**
 * Record a tool call's usage telemetry and report it if it ran out of disk.
 * Runs inside the tool's runtime context, which supplies the agent and
 * conversation IDs.
 */
export function trackToolOutcome(
  toolName: string,
  success: boolean,
  duration: number,
  response: unknown,
  errorType?: string,
  errorDetails?: string,
): void {
  const responseSize =
    typeof response === "string"
      ? response.length
      : JSON.stringify(response).length;
  telemetry.trackToolUsage(
    toolName,
    success,
    duration,
    responseSize,
    errorType,
    errorDetails,
  );
  const context = getRuntimeContext();
  reportDiskFullIfDetected({
    toolName,
    output: typeof response === "string" ? response : errorDetails,
    agentId: context?.agentId,
    conversationId: context?.conversationId,
    cwd: getCurrentWorkingDirectory(),
  });
}
