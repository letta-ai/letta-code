import type WebSocket from "ws";
import type { StatusMessage } from "../../types/protocol_v2";
import { debugLog } from "../../utils/debug";
import { emitStatusDelta } from "./protocol-outbound";
import type { ConversationRuntime, ListenerRuntime } from "./types";

export type RecoverableStatusNoticeKind = "stale_approval_conflict_recovery";

export const DESKTOP_DEBUG_PANEL_INFO_PREFIX =
  "[LETTA_DESKTOP_DEBUG_PANEL_INFO]";

function isDesktopDebugPanelMirrorEnabled(): boolean {
  return process.env.LETTA_DESKTOP_DEBUG_PANEL === "1";
}

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
