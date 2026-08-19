export type LoopStatus =
  | "SENDING_API_REQUEST"
  | "WAITING_FOR_API_RESPONSE"
  | "RETRYING_API_REQUEST"
  | "PROCESSING_API_RESPONSE"
  | "EXECUTING_CLIENT_SIDE_TOOL"
  | "EXECUTING_COMMAND"
  | "WAITING_ON_APPROVAL"
  | "WAITING_ON_INPUT";

/** Authoritative listener-owned state for one conversation loop. */
export interface LoopState {
  status: LoopStatus;
  active_run_ids: string[];
  /** Exact send identities consumed by each recently observed run. */
  client_message_ids_by_run_id?: Record<string, string[]>;
  /**
   * Tool call ids currently executing client-side. Populated only while
   * `status` is `EXECUTING_CLIENT_SIDE_TOOL`; empty otherwise. Lets
   * observer UIs render an authoritative executing set that self-heals on
   * every status frame instead of pairing client_tool_start/end lifecycle
   * events, which are unrecoverable if a frame is lost.
   */
  executing_tool_call_ids: string[];
}
