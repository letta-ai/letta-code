import { createHash } from "node:crypto";

const TOOL_USAGE_AGGREGATE_TOOL_NAME = "aggregate";
const MAX_ERROR_SUMMARY_MESSAGE_LENGTH = 500;
const MAX_ERROR_SUMMARY_FIELD_LENGTH = 120;
const MAX_TOOL_NAME_LENGTH = 120;

export const MAX_ERROR_FINGERPRINTS = 128;
export const ERROR_SUPPRESSION_SUMMARY_INTERVAL_MS = 30 * 60 * 1000;
export const MAX_TOOL_USAGE_DISTINCT_TOOLS = 64;

export interface ToolUsageToolSummary {
  tool_name: string;
  call_count: number;
  success_count: number;
  error_count: number;
}

interface ToolUsageToolState {
  toolName: string;
  callCount: number;
  successCount: number;
  errorCount: number;
}

export interface ToolUsageAggregateState {
  callCount: number;
  successCount: number;
  errorCount: number;
  totalDurationMs: number;
  totalResponseLength: number;
  overflowToolCallCount: number;
  tools: Map<string, ToolUsageToolState>;
  agentId: string | null;
  mixedAgentIds: boolean;
}

export interface ErrorSuppressionSummaryData {
  error_type: string;
  error_message: string;
  context?: string;
  http_status?: number;
  model_id?: string;
  suppressed_count?: number;
}

export interface ErrorSuppressionState {
  summaryData: ErrorSuppressionSummaryData;
  suppressedCount: number;
  agentId: string | null;
  mixedAgentIds: boolean;
}

export interface AggregateEvent<TData> {
  data: TData;
  agentId: string | null;
}

function toFiniteNonNegativeInteger(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.round(value);
}

function normalizeErrorFingerprintValue(
  value: string | undefined,
): string | null {
  const normalized = (value ?? "").trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function normalizeBoundedString(
  value: string | undefined,
  fallback: string,
  maxLength: number,
): string {
  const normalized = normalizeErrorFingerprintValue(value) ?? fallback;
  return normalized.length <= maxLength
    ? normalized
    : normalized.slice(0, maxLength);
}

function normalizeToolName(toolName: string): string {
  return normalizeBoundedString(toolName, "unknown_tool", MAX_TOOL_NAME_LENGTH);
}

export function createErrorFingerprint(args: {
  errorType: string;
  errorMessage: string;
  context?: string;
  httpStatus?: number;
  modelId?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        context: normalizeErrorFingerprintValue(args.context),
        error_message: normalizeErrorFingerprintValue(args.errorMessage) ?? "",
        error_type:
          normalizeErrorFingerprintValue(args.errorType) ?? "unknown_error",
        http_status:
          typeof args.httpStatus === "number" &&
          Number.isFinite(args.httpStatus)
            ? args.httpStatus
            : null,
        model_id: normalizeErrorFingerprintValue(args.modelId),
      }),
    )
    .digest("hex")
    .slice(0, 32);
}

export function recordToolUsageAggregate(
  aggregate: ToolUsageAggregateState | null,
  agentId: string | null,
  toolName: string,
  success: boolean,
  duration: number,
  responseLength?: number,
): ToolUsageAggregateState {
  const next =
    aggregate ??
    ({
      callCount: 0,
      successCount: 0,
      errorCount: 0,
      totalDurationMs: 0,
      totalResponseLength: 0,
      overflowToolCallCount: 0,
      tools: new Map(),
      agentId,
      mixedAgentIds: false,
    } satisfies ToolUsageAggregateState);

  if (next.agentId !== agentId) {
    next.mixedAgentIds = true;
  }
  next.callCount += 1;
  next.totalDurationMs += toFiniteNonNegativeInteger(duration);
  next.totalResponseLength += toFiniteNonNegativeInteger(responseLength);
  if (success) {
    next.successCount += 1;
  } else {
    next.errorCount += 1;
  }

  const normalizedToolName = normalizeToolName(toolName);
  let tool = next.tools.get(normalizedToolName);
  if (!tool) {
    if (next.tools.size >= MAX_TOOL_USAGE_DISTINCT_TOOLS) {
      next.overflowToolCallCount += 1;
      return next;
    }
    tool = {
      toolName: normalizedToolName,
      callCount: 0,
      successCount: 0,
      errorCount: 0,
    };
    next.tools.set(normalizedToolName, tool);
  }

  tool.callCount += 1;
  if (success) {
    tool.successCount += 1;
  } else {
    tool.errorCount += 1;
  }
  return next;
}

export function consumeToolUsageAggregate(
  aggregate: ToolUsageAggregateState | null,
): AggregateEvent<{
  tool_name: string;
  success: boolean;
  duration: number;
  response_length?: number;
  call_count: number;
  success_count: number;
  error_count: number;
  tools: ToolUsageToolSummary[];
  overflow_tool_call_count?: number;
  tool_name_limit?: number;
}> | null {
  if (!aggregate || aggregate.callCount === 0) {
    return null;
  }
  const tools = Array.from(aggregate.tools.values())
    .sort(
      (left, right) =>
        right.callCount - left.callCount ||
        left.toolName.localeCompare(right.toolName),
    )
    .map(
      (tool): ToolUsageToolSummary => ({
        tool_name: tool.toolName,
        call_count: tool.callCount,
        success_count: tool.successCount,
        error_count: tool.errorCount,
      }),
    );

  return {
    data: {
      tool_name: TOOL_USAGE_AGGREGATE_TOOL_NAME,
      success: aggregate.errorCount === 0,
      duration: aggregate.totalDurationMs,
      ...(aggregate.totalResponseLength > 0
        ? { response_length: aggregate.totalResponseLength }
        : {}),
      call_count: aggregate.callCount,
      success_count: aggregate.successCount,
      error_count: aggregate.errorCount,
      tools,
      ...(aggregate.overflowToolCallCount > 0
        ? {
            overflow_tool_call_count: aggregate.overflowToolCallCount,
            tool_name_limit: MAX_TOOL_USAGE_DISTINCT_TOOLS,
          }
        : {}),
    },
    agentId: aggregate.mixedAgentIds ? null : aggregate.agentId,
  };
}

export function createErrorSuppressionState(
  data: {
    error_type: string;
    error_message: string;
    context?: string;
    http_status?: number;
    model_id?: string;
  },
  agentId: string | null,
): ErrorSuppressionState {
  return {
    summaryData: {
      error_type: normalizeBoundedString(
        data.error_type,
        "unknown_error",
        MAX_ERROR_SUMMARY_FIELD_LENGTH,
      ),
      error_message: normalizeBoundedString(
        data.error_message,
        "unknown error",
        MAX_ERROR_SUMMARY_MESSAGE_LENGTH,
      ),
      context: data.context
        ? normalizeBoundedString(
            data.context,
            "unknown_context",
            MAX_ERROR_SUMMARY_FIELD_LENGTH,
          )
        : undefined,
      http_status: data.http_status,
      model_id: data.model_id
        ? normalizeBoundedString(
            data.model_id,
            "unknown_model",
            MAX_ERROR_SUMMARY_FIELD_LENGTH,
          )
        : undefined,
    },
    suppressedCount: 0,
    agentId,
    mixedAgentIds: false,
  };
}

export function updateErrorSuppressionAgentScope(
  state: ErrorSuppressionState,
  agentId: string | null,
): void {
  if (state.agentId !== agentId) {
    state.mixedAgentIds = true;
  }
}

export function consumeErrorSuppressionSummary(
  state: ErrorSuppressionState,
): AggregateEvent<ErrorSuppressionSummaryData> | null {
  if (state.suppressedCount <= 0) {
    return null;
  }
  const data = {
    ...state.summaryData,
    suppressed_count: state.suppressedCount,
  };
  state.suppressedCount = 0;
  return { data, agentId: state.mixedAgentIds ? null : state.agentId };
}

export function hasPendingErrorSuppressionSummaries(
  states: Map<string, ErrorSuppressionState>,
): boolean {
  for (const state of states.values()) {
    if (state.suppressedCount > 0) {
      return true;
    }
  }
  return false;
}

export function hasDueErrorSuppressionSummary(
  nextSummaryMs: number | null,
  states: Map<string, ErrorSuppressionState>,
  now = Date.now(),
): boolean {
  return (
    nextSummaryMs !== null &&
    now >= nextSummaryMs &&
    hasPendingErrorSuppressionSummaries(states)
  );
}
