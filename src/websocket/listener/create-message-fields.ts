import type { InputCreateMessagePayload } from "@/types/protocol_v2";
import type { IncomingMessage } from "./types";

/**
 * Map a create_message input payload onto the turn fields of an
 * IncomingMessage. Identity fields (connectionId, agentId, conversationId)
 * stay at the call site; this carries only payload-derived options.
 */
export function createMessageTurnFields(
  inputPayload: InputCreateMessagePayload,
): Pick<
  IncomingMessage,
  | "clientToolAllowlist"
  | "clientToolset"
  | "externalToolScopeIds"
  | "excludeInteractiveTools"
  | "responseFormat"
  | "githubPullRequestConversationIds"
  | "imageFailureMode"
  | "messages"
> {
  return {
    clientToolAllowlist: inputPayload.client_tool_allowlist,
    clientToolset: inputPayload.client_toolset,
    externalToolScopeIds: inputPayload.external_tool_scope_ids,
    excludeInteractiveTools: inputPayload.exclude_interactive_tools,
    responseFormat: inputPayload.response_format,
    githubPullRequestConversationIds:
      inputPayload.github_pull_request_conversation_ids,
    imageFailureMode: inputPayload.image_failure_mode,
    messages: inputPayload.messages,
  };
}
