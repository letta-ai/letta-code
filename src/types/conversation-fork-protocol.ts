export interface ConversationForkBody {
  /** Agent ID for agent-direct mode with the default conversation. */
  agent_id?: string | null;
  /** Whether the forked conversation should be hidden. */
  hidden?: boolean;
  /** Optional projected message ID to fork through, inclusive. */
  message_id?: string;
}
