import type { QueueItemSource } from "./protocol";
import type { ConversationRuntimeScope } from "./runtime-scope";

export interface QueueRemovalTransition {
  client_message_id: string;
  disposition: "dequeued" | "cancelled";
  source?: QueueItemSource;
}

export interface ResumeQueueCommand {
  type: "resume_queue";
  runtime: ConversationRuntimeScope;
  request_id?: string;
}

export interface ResumeQueueResponseMessage {
  type: "resume_queue_response";
  request_id: string;
  runtime: ConversationRuntimeScope;
  resumed: number;
  success: boolean;
  error?: string;
}
