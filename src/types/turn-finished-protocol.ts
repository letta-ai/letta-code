import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";

/** Terminal outcome fields, independent of the runtime envelope. */
export interface TurnFinishedFields {
  type: "turn_finished";
  turn_id: string;
  stop_reason: StopReasonType;
  run_id?: string;
  /** Inputs owned by this turn, including failures before a run is created. */
  client_message_ids?: string[];
  error?: string;
  /** Final CLI counters, independent of control/stream socket delivery order. */
  usage?: LettaStreamingResponse.LettaUsageStatistics;
}
