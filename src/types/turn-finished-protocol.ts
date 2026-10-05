/** Peer application receipt for a durably replayable terminal event. */
export interface TurnFinishedAckCommand {
  type: "turn_finished_ack";
  runtime: { agent_id: string | null; conversation_id: string };
  idempotency_key: string;
}
