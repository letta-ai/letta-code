export type ChannelTurnProgressKind =
  | "thinking"
  | "responding"
  | "tool"
  | "approval"
  | "command"
  | "status"
  | "retry"
  | "error";

export type ChannelTurnProgressState =
  | "started"
  | "updated"
  | "completed"
  | "error"
  | "waiting";

export interface ChannelTurnProgressUpdate {
  kind: ChannelTurnProgressKind;
  state: ChannelTurnProgressState;
  /** Sanitized, user-facing status text. Never include tool args or output. */
  message: string;
  toolCallId?: string;
  toolName?: string;
  /** Optional sanitized argument summary for expanded tool progress details. */
  toolDetails?: string;
  /**
   * Optional sanitized error-output preview for failed tool calls. Kept
   * separate from toolDetails so surfaces can render it as secondary detail
   * text; it must never be used as a row title/header (LET-9509).
   */
  errorDetails?: string;
  /** Optional sanitized row title for native/rich progress surfaces. */
  toolTitle?: string;
  /**
   * First useful tool title in the model step, for single-line status surfaces.
   * Null means the step has no title yet. Individual tool titles stay unchanged.
   */
  toolBatchTitle?: string | null;
  command?: string;
  runId?: string;
}
