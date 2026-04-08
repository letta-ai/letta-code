import { APIError, APIUserAbortError } from "@letta-ai/letta-client/core/error";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type WebSocket from "ws";
import type { RunErrorInfo } from "../../agent/approval-recovery";
import { extractConflictDetail } from "../../agent/turn-recovery-policy";
import {
  checkCloudflareEdgeError,
  formatErrorDetails,
} from "../../cli/helpers/errorFormatter";
import type { ErrorInfo } from "../../cli/helpers/streamProcessor";
import type { StatusMessage, StopReasonType } from "../../types/protocol_v2";
import { debugLog } from "../../utils/debug";
import {
  emitLoopErrorDelta,
  emitRetryDelta,
  emitStatusDelta,
} from "./protocol-outbound";
import type { ConversationRuntime, ListenerRuntime } from "./types";

export type RecoverableStatusNoticeKind = "stale_approval_conflict_recovery";
export type RecoverableRetryNoticeKind = "transient_provider_retry";

type LifecycleNoticeVisibility = "debug_only" | "transcript";

type StructuredLoopErrorInfo =
  | ErrorInfo
  | RunErrorInfo
  | LettaStreamingResponse.LettaErrorMessage;

export interface LoopErrorNoticeDecision {
  visibility: LifecycleNoticeVisibility;
  message: string;
  apiError?: LettaStreamingResponse.LettaErrorMessage;
}

export const DESKTOP_DEBUG_PANEL_INFO_PREFIX =
  "[LETTA_DESKTOP_DEBUG_PANEL_INFO]";

export function getRecoverableStatusNoticeVisibility(
  kind: RecoverableStatusNoticeKind,
): "debug_only" | "transcript" {
  switch (kind) {
    case "stale_approval_conflict_recovery":
      return "debug_only";
    default:
      return "transcript";
  }
}

export function getRecoverableRetryNoticeVisibility(
  kind: RecoverableRetryNoticeKind,
  attempt: number,
): "debug_only" | "transcript" {
  switch (kind) {
    case "transient_provider_retry":
      return attempt === 1 ? "debug_only" : "transcript";
    default:
      return "transcript";
  }
}

function isDesktopDebugPanelMirrorEnabled(): boolean {
  return process.env.LETTA_DESKTOP_DEBUG_PANEL === "1";
}

function mirrorRecoverableNoticeToDesktopDebugPanel(message: string): void {
  if (!isDesktopDebugPanelMirrorEnabled()) {
    return;
  }

  try {
    process.stderr.write(`${DESKTOP_DEBUG_PANEL_INFO_PREFIX} ${message}\n`);
  } catch {
    // Best-effort only.
  }
}

function toStructuredApiError(
  errorInfo?: StructuredLoopErrorInfo,
): LettaStreamingResponse.LettaErrorMessage | undefined {
  if (!errorInfo?.error_type || !errorInfo.run_id) {
    return undefined;
  }

  return {
    message_type: "error_message",
    message: errorInfo.message || errorInfo.detail || "An error occurred",
    error_type: errorInfo.error_type,
    run_id: errorInfo.run_id,
    ...(errorInfo.detail ? { detail: errorInfo.detail } : {}),
  };
}

function getStructuredApiErrorFromError(
  error: unknown,
): LettaStreamingResponse.LettaErrorMessage | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const errorWithStructuredInfo = error as Error & {
    apiError?: LettaStreamingResponse.LettaErrorMessage;
    runErrorInfo?: RunErrorInfo;
  };

  return (
    errorWithStructuredInfo.apiError ??
    toStructuredApiError(errorWithStructuredInfo.runErrorInfo)
  );
}

function buildStructuredFormatInput(
  apiError: LettaStreamingResponse.LettaErrorMessage,
): {
  error: {
    error: {
      type: string;
      message: string;
      detail?: string;
    };
    run_id: string;
  };
} {
  return {
    error: {
      error: {
        type: apiError.error_type,
        message: apiError.message,
        ...(apiError.detail ? { detail: apiError.detail } : {}),
      },
      run_id: apiError.run_id,
    },
  };
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof APIUserAbortError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const errorWithCode = error as Error & { code?: string };

  return (
    error.name === "AbortError" ||
    error.message === "The operation was aborted" ||
    errorWithCode.code === "ABORT_ERR"
  );
}

function isTerminatedProcessNoise(message: string): boolean {
  return message.trim().toLowerCase() === "terminated";
}

function isProxyTransportError(
  detail: string,
  error: unknown,
  message: string,
): boolean {
  if (
    error instanceof APIError &&
    error.status >= 500 &&
    detail.toLowerCase().includes("trying to proxy")
  ) {
    return true;
  }

  return (
    detail.toLowerCase().includes("error occurred while trying to proxy") ||
    message.toLowerCase().includes("error occurred while trying to proxy")
  );
}

export function getLoopErrorNoticeDecision(params: {
  message: string;
  error?: unknown;
  errorInfo?: ErrorInfo;
  runErrorInfo?: RunErrorInfo;
  apiError?: LettaStreamingResponse.LettaErrorMessage;
  agentId?: string | null;
  conversationId?: string | null;
  cancelRequested?: boolean;
  abortSignal?: AbortSignal;
}): LoopErrorNoticeDecision {
  const apiError =
    params.apiError ??
    toStructuredApiError(params.errorInfo) ??
    toStructuredApiError(params.runErrorInfo) ??
    getStructuredApiErrorFromError(params.error);
  const detail =
    apiError?.detail ??
    params.errorInfo?.detail ??
    params.runErrorInfo?.detail ??
    extractConflictDetail(params.error) ??
    "";

  if (
    params.cancelRequested ||
    params.abortSignal?.aborted ||
    isAbortLikeError(params.error) ||
    isTerminatedProcessNoise(params.message)
  ) {
    return {
      visibility: "debug_only",
      message: params.message,
    };
  }

  const cloudflareMessage =
    checkCloudflareEdgeError(detail) ??
    checkCloudflareEdgeError(params.message);
  if (cloudflareMessage) {
    return {
      visibility: "transcript",
      message: cloudflareMessage,
      apiError,
    };
  }

  if (isProxyTransportError(detail, params.error, params.message)) {
    return {
      visibility: "transcript",
      message: "Connection to Letta service failed. Please retry.",
      apiError,
    };
  }

  const formattedMessage = formatErrorDetails(
    apiError
      ? buildStructuredFormatInput(apiError)
      : (params.error ?? params.message),
    params.agentId ?? undefined,
    params.conversationId ?? undefined,
  );

  return {
    visibility: "transcript",
    message: formattedMessage,
    apiError,
  };
}

export function emitLoopErrorNotice(
  socket: WebSocket,
  runtime: ListenerRuntime | ConversationRuntime,
  params: {
    message: string;
    stopReason: StopReasonType;
    isTerminal: boolean;
    runId?: string | null;
    agentId?: string | null;
    conversationId?: string | null;
    error?: unknown;
    errorInfo?: ErrorInfo;
    runErrorInfo?: RunErrorInfo;
    apiError?: LettaStreamingResponse.LettaErrorMessage;
    cancelRequested?: boolean;
    abortSignal?: AbortSignal;
  },
): void {
  const decision = getLoopErrorNoticeDecision(params);

  if (decision.visibility === "debug_only") {
    debugLog(
      "recovery",
      `Debug-only loop error (${params.stopReason}): ${params.message}`,
    );
    mirrorRecoverableNoticeToDesktopDebugPanel(params.message);
    return;
  }

  emitLoopErrorDelta(socket, runtime, {
    message: decision.message,
    stopReason: params.stopReason,
    isTerminal: params.isTerminal,
    runId: params.runId,
    agentId: params.agentId,
    conversationId: params.conversationId,
    apiError: decision.apiError,
  });
}

export function emitRecoverableStatusNotice(
  socket: WebSocket,
  runtime: ListenerRuntime | ConversationRuntime,
  params: {
    kind: RecoverableStatusNoticeKind;
    message: string;
    level: StatusMessage["level"];
    runId?: string | null;
    agentId?: string | null;
    conversationId?: string | null;
  },
): void {
  const visibility = getRecoverableStatusNoticeVisibility(params.kind);

  if (visibility === "debug_only") {
    debugLog(
      "recovery",
      `Debug-only lifecycle notice (${params.kind}): ${params.message}`,
    );
    mirrorRecoverableNoticeToDesktopDebugPanel(params.message);
    return;
  }

  emitStatusDelta(socket, runtime, {
    message: params.message,
    level: params.level,
    runId: params.runId,
    agentId: params.agentId,
    conversationId: params.conversationId,
  });
}

export function emitRecoverableRetryNotice(
  socket: WebSocket,
  runtime: ListenerRuntime | ConversationRuntime,
  params: Parameters<typeof emitRetryDelta>[2] & {
    kind: RecoverableRetryNoticeKind;
  },
): void {
  const visibility = getRecoverableRetryNoticeVisibility(
    params.kind,
    params.attempt,
  );

  if (visibility === "debug_only") {
    debugLog(
      "recovery",
      `Debug-only retry notice (${params.kind}, attempt ${params.attempt}/${params.maxAttempts}): ${params.message}`,
    );
    mirrorRecoverableNoticeToDesktopDebugPanel(params.message);
    return;
  }

  emitRetryDelta(socket, runtime, {
    message: params.message,
    reason: params.reason,
    attempt: params.attempt,
    maxAttempts: params.maxAttempts,
    delayMs: params.delayMs,
    runId: params.runId,
    agentId: params.agentId,
    conversationId: params.conversationId,
  });
}
