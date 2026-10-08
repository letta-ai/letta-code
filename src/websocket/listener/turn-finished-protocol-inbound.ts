import {
  isTerminalConsumerId,
  type TurnFinishedAckCommand,
} from "@/types/turn-finished-protocol";
import { isRuntimeScope } from "./protocol-validation";

export function isTurnFinishedAckCommand(
  value: unknown,
): value is TurnFinishedAckCommand {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    type?: unknown;
    runtime?: unknown;
    idempotency_key?: unknown;
    consumer_id?: unknown;
  };
  return (
    candidate.type === "turn_finished_ack" &&
    isRuntimeScope(candidate.runtime) &&
    typeof candidate.idempotency_key === "string" &&
    candidate.idempotency_key.length > 0 &&
    candidate.idempotency_key.length <= 256 &&
    isTerminalConsumerId(candidate.consumer_id)
  );
}
