import type { ConversationRuntimeScope } from "./runtime-scope";

export interface QueueRemovalTransition {
  client_message_id: string;
  disposition: "dequeued" | "cancelled";
}

/**
 * Release queue items parked by a user interrupt (`abort_message` / Esc) so
 * they start the next turn. A new `input` message resumes the queue
 * implicitly; this command resumes it without adding a message (the "Resume"
 * affordance). Parked items carry `paused: true` in `update_queue` snapshots.
 */
export interface ResumeQueueCommand {
  type: "resume_queue";
  runtime: ConversationRuntimeScope;
  /** When provided, app-server sends resume_queue_response on the control channel. */
  request_id?: string;
}

export interface ResumeQueueResponseMessage {
  type: "resume_queue_response";
  request_id: string;
  runtime: ConversationRuntimeScope;
  /** Number of queue items released by this command. */
  resumed: number;
  success: boolean;
  error?: string;
}
