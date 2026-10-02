import type { ConversationRuntimeScope } from "./runtime-scope";

export interface AbortMessageCommand {
  type: "abort_message";
  runtime: ConversationRuntimeScope;
  request_id?: string; // Sends a control-channel response when provided.
  run_id?: string | null;
  wait_for_settlement?: boolean;
  pause_queue?: boolean;
}

/**
 * - interrupted: this request stopped an active turn or pending approval.
 * - joined: the target lease was already cancelling; this request waited on it.
 * - already_settled: the exact run belonged to a lease that has since settled.
 * - queue_fenced: broad abort with no turn to stop and user-authored input
 *   queued; that input is now parked so no queued successor can start. An
 *   empty queue has nothing to fence and reports not_applicable.
 * - not_applicable: no lease owns this exact run, or nothing to stop or fence.
 */
export type AbortMessageOutcome =
  | "interrupted"
  | "joined"
  | "already_settled"
  | "queue_fenced"
  | "not_applicable";

export interface AbortMessageResponseMessage {
  type: "abort_message_response";
  request_id: string;
  runtime: ConversationRuntimeScope;
  aborted: boolean; // The target turn or approval was (or already had been) interrupted.
  lease_settled?: boolean; // Listener waited for its original lease.
  /** How the listener applied this abort; absent on older listeners. */
  outcome?: AbortMessageOutcome;
  /**
   * Authoritative queue state after this abort, on every outcome: true when at
   * least one user-authored queued input is parked until resume_queue, false
   * when nothing is parked (including an empty queue). Absent when the
   * listener could not read the queue, which is not a claim either way.
   */
  queue_paused?: boolean;
  success: boolean;
  error?: string;
}
