export interface QueueRemovalTransition {
  client_message_id: string;
  disposition: "dequeued" | "cancelled";
}
