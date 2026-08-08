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
