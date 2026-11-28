import type {
  AgentListParams,
  AgentState,
} from "@letta-ai/letta-client/resources/agents/agents";

export interface PickerAgent {
  id: string;
  name?: string | null;
  description?: string | null;
  model?: AgentState["model"];
  memoryBlockCount?: number;
  last_run_completion?: string | null;
  creator?: { id: string; name?: string | null } | null;
}

export type PickerCollection = "pinned" | "shared";
export type PickerPageRequest = {
  type: "agent_picker_page";
  request_id: string;
  collection: PickerCollection;
  after?: string;
  query?: string;
};
export type PickerPageResponse = {
  type: "agent_picker_page_response";
  request_id: string;
  success: boolean;
  agents?: PickerAgent[];
  nextCursor?: string | null;
  error?: string;
};

export interface PickerUnpinRequest {
  type: "agent_picker_unpin";
  request_id: string;
  agent_id: string;
}
export interface PickerUnpinResponse {
  type: "agent_picker_unpin_response";
  request_id: string;
  success: boolean;
  error?: string;
}
export type PickerRequest = PickerPageRequest | PickerUnpinRequest;
export type PickerResponse = PickerPageResponse | PickerUnpinResponse;
export interface AgentListCommand {
  type: "agent_list";
  request_id: string;
  query?: AgentListParams;
}

export interface AgentListResponseMessage {
  type: "agent_list_response";
  request_id: string;
  success: boolean;
  agents: AgentState[];
  error?: string;
}
