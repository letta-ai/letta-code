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
  message: string;
  toolCallId?: string;
  toolName?: string;
  toolDetails?: string;
  errorDetails?: string;
  toolTitle?: string;
  toolBatchTitle?: string | null;
  command?: string;
  runId?: string;
}
