export interface UmiLifecycleMessageBase {
  id: string;
  date: string;
  message_type: string;
  run_id?: string;
}

export interface ApprovalClassificationEndMessage
  extends UmiLifecycleMessageBase {
  message_type: "approval_classification_end";
  auto_allowed_tool_call_ids: string[];
  auto_denied_tool_call_ids: string[];
  user_input_tool_call_ids: string[];
}
