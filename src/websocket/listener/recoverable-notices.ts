import type WebSocket from "ws";
import type { StatusMessage } from "../../types/protocol_v2";
import { debugLog } from "../../utils/debug";
import { emitRetryDelta, emitStatusDelta } from "./protocol-outbound";
import type { ConversationRuntime, ListenerRuntime } from "./types";

export type RecoverableStatusNoticeKind = "stale_approval_conflict_recovery";
export type RecoverableRetryNoticeKind = "transient_provider_retry";

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
