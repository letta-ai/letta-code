import type { AppServerInfoCommand } from "@/types/app-server-info";
import type { ConversationForkBody } from "@/types/conversation-fork-protocol";
import type { ConversationForkCommand } from "@/types/protocol_v2";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isConversationForkBody(value: unknown): value is ConversationForkBody {
  if (!isObjectRecord(value)) return false;
  return (
    (value.agent_id === undefined ||
      value.agent_id === null ||
      (typeof value.agent_id === "string" && value.agent_id.length > 0)) &&
    (value.hidden === undefined || typeof value.hidden === "boolean") &&
    (value.message_id === undefined ||
      (typeof value.message_id === "string" && value.message_id.length > 0))
  );
}

export function isAppServerInfoCommand(
  value: unknown,
): value is AppServerInfoCommand {
  if (!isObjectRecord(value)) return false;
  return (
    value.type === "app_server_info" &&
    typeof value.request_id === "string" &&
    value.request_id.length > 0
  );
}

export function isConversationForkCommand(
  value: unknown,
): value is ConversationForkCommand {
  if (!isObjectRecord(value)) return false;
  return (
    value.type === "conversation_fork" &&
    typeof value.request_id === "string" &&
    typeof value.conversation_id === "string" &&
    (value.body === undefined || isConversationForkBody(value.body))
  );
}
