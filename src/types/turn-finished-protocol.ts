export const MAX_TERMINAL_CONSUMER_ID_LENGTH = 256;

export function isTerminalConsumerId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TERMINAL_CONSUMER_ID_LENGTH &&
    /^[A-Za-z0-9._~:%-]+$/.test(value)
  );
}

/** Peer application receipt for a durably replayable terminal event. */
export interface TurnFinishedAckCommand {
  type: "turn_finished_ack";
  runtime: { agent_id: string | null; conversation_id: string };
  idempotency_key: string;
  consumer_id: string;
}
