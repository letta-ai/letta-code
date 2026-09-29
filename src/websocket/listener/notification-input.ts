import type { InputCreateNotificationMessagePayload } from "@/types/notification-sponsorship";
import type {
  InputCommand,
  InputCreateMessagePayload,
  InputPayload,
} from "@/types/protocol_v2";
import type { IncomingMessage, ListenerConnectionId } from "./types";

export type MessageInputPayload =
  | InputCreateMessagePayload
  | InputCreateNotificationMessagePayload;

function isMessageInputPayload(
  payload: InputPayload,
): payload is MessageInputPayload {
  return (
    payload.kind === "create_message" ||
    payload.kind === "create_notification_message"
  );
}

function getNotificationInputOptions(
  payload: MessageInputPayload,
): Partial<Pick<IncomingMessage, "notificationSponsorship" | "noCoalesce">> {
  return payload.kind === "create_notification_message"
    ? {
        notificationSponsorship: payload.notification_sponsorship,
        noCoalesce: true,
      }
    : {};
}

export function createIncomingMessage(
  payload: InputPayload,
  runtime: InputCommand["runtime"],
  connectionId: ListenerConnectionId,
): IncomingMessage | null {
  if (!isMessageInputPayload(payload)) return null;
  return {
    type: "message",
    connectionId,
    ...(runtime.agent_id ? { agentId: runtime.agent_id } : {}),
    conversationId: runtime.conversation_id,
    clientToolAllowlist: payload.client_tool_allowlist,
    clientToolset: payload.client_toolset,
    externalToolScopeIds: payload.external_tool_scope_ids,
    excludeInteractiveTools: payload.exclude_interactive_tools,
    responseFormat: payload.response_format,
    imageFailureMode: payload.image_failure_mode,
    messages: payload.messages,
    ...getNotificationInputOptions(payload),
  };
}
