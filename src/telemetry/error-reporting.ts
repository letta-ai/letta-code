import { telemetry } from "./index";

export type BoundaryErrorOptions = {
  context: string;
  errorType: string;
  error: unknown;
  httpStatus?: number;
  modelId?: string;
  runId?: string;
  recentChunks?: Record<string, unknown>[];
};

export function formatTelemetryErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function trackBoundaryError(options: BoundaryErrorOptions): void {
  telemetry.trackError(
    options.errorType,
    formatTelemetryErrorMessage(options.error),
    options.context,
    {
      httpStatus: options.httpStatus,
      modelId: options.modelId,
      runId: options.runId,
      recentChunks: options.recentChunks,
    },
  );
}

export function reportListenerStateWriteFailure(options: {
  phase: "run_observed" | "before_tool_execution" | "after_tool_execution";
  error: unknown;
  agentId: string;
  conversationId: string;
  runId?: string;
  toolCallId?: string;
}): void {
  // Filesystem messages contain paths; report only codes and opaque IDs.
  try {
    const safeId = (id: string | undefined) =>
      id && /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? id : undefined;
    const { code, syscall } = (options.error ?? {}) as NodeJS.ErrnoException;
    const errorCode =
      typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)
        ? code
        : "UNKNOWN";
    telemetry.trackError(
      "listener_state_write_failed",
      "Listener state write failed",
      JSON.stringify({
        phase: options.phase,
        error_code: errorCode,
        syscall:
          typeof syscall === "string" && /^[a-z]{1,32}$/.test(syscall)
            ? syscall
            : undefined,
        agent_id: safeId(options.agentId),
        conversation_id: safeId(options.conversationId),
        tool_call_id: safeId(options.toolCallId),
      }),
      { runId: safeId(options.runId), omitDebugLogTail: true },
    );
    void telemetry.flush().catch(() => {});
  } catch {
    // A diagnostic must never mask the original filesystem failure.
  }
}

export function trackEndTurnNoAssistant(params: {
  fallbackKind: "reasoning" | "tool_call";
  modelHandle?: string;
  runId?: string;
  isSubagent: boolean;
  subagentType?: string;
}): void {
  telemetry.trackError(
    "end_turn_no_assistant",
    `end_turn fell back to ${params.fallbackKind}`,
    "headless_result_extraction",
    {
      modelId: params.modelHandle,
      runId: params.runId,
      isSubagent: params.isSubagent,
      subagentType: params.subagentType,
      modelHandle: params.modelHandle,
      fallbackKind: params.fallbackKind,
    },
  );
}

export type ExternalWorkerFailureStage =
  | "resolve_computer"
  | "outdated_computer"
  | "connect"
  | "launch_request"
  | "launch_rejected"
  | "follow_up";

/** The HTTP status an error message starts with or carries after a colon. */
export function extractHttpStatus(message: string): number | undefined {
  const match = /(?:^|:\s*)([45]\d{2})\b/.exec(message);
  return match ? Number(match[1]) : undefined;
}

/**
 * Report a Claude Code / Codex (or other external worker) launch or
 * follow-up that failed before the worker started.
 *
 * Error messages can quote prompts, paths, or server text, so only the stage,
 * worker type, HTTP status, error code, and opaque IDs are sent.
 */
export function reportExternalWorkerLaunchFailure(options: {
  stage: ExternalWorkerFailureStage;
  harness: string;
  computer?: string;
  error: unknown;
  errorCode?: string;
  agentId?: string;
  conversationId?: string;
  toolCallId?: string;
}): void {
  try {
    const safe = (value: string | undefined, pattern: RegExp) =>
      value && pattern.test(value) ? value : undefined;
    const safeId = (id: string | undefined) =>
      safe(id, /^[a-zA-Z0-9_-]{1,128}$/);
    const httpStatus = extractHttpStatus(
      formatTelemetryErrorMessage(options.error),
    );
    telemetry.trackError(
      "external_worker_launch_failed",
      "External worker launch failed",
      JSON.stringify({
        stage: options.stage,
        harness: safe(options.harness, /^[a-z-]{1,32}$/),
        computer: safe(options.computer, /^[a-zA-Z0-9_.:-]{1,128}$/),
        error_code: safe(options.errorCode, /^[a-zA-Z0-9_]{1,64}$/),
        agent_id: safeId(options.agentId),
        conversation_id: safeId(options.conversationId),
        tool_call_id: safeId(options.toolCallId),
      }),
      { httpStatus, omitDebugLogTail: true },
    );
    void telemetry.flush().catch(() => {});
  } catch {
    // A diagnostic must never mask the launch failure itself.
  }
}
