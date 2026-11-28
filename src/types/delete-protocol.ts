export interface AgentDeleteCommand {
  type: "agent_delete";
  request_id: string;
  agent_id: string;
}

export interface AgentDeleteResponseMessage {
  type: "agent_delete_response";
  request_id: string;
  success: boolean;
  agent_id: string;
  error?: string;
}

export interface ConversationDeleteCommand {
  type: "conversation_delete";
  request_id: string;
  conversation_id: string;
}

export interface ConversationDeleteResponseMessage {
  type: "conversation_delete_response";
  request_id: string;
  success: boolean;
  conversation_id: string;
  error?: string;
}
