import type {
  StopReasonType,
  StreamDeltaMessage,
} from "@/types/app-server-protocol";

export function stopReasonFromDelta(
  message: StreamDeltaMessage,
): StopReasonType | null {
  const delta = message.delta;
  return delta.message_type === "stop_reason" &&
    "stop_reason" in delta &&
    typeof delta.stop_reason === "string"
    ? delta.stop_reason
    : null;
}

export function runIdFromDelta(
  message: StreamDeltaMessage,
): string | undefined {
  const runId = "run_id" in message.delta ? message.delta.run_id : undefined;
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

export function lifecycleOutcome(
  stopReason: StopReasonType,
): "completed" | "error" | "cancelled" {
  if (stopReason === "cancelled") return "cancelled";
  if (stopReason === "end_turn" || stopReason === "tool_rule")
    return "completed";
  return "error";
}
