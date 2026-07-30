import { actingUserRequestOptions } from "@/agent/acting-user";
import { getBackend } from "@/backend/backend";

// Cloud schedules persist this target so the execution listener can resolve it per fire.
const NEW_CONVERSATION_TARGET = "new";

export type InputRuntimeScope = {
  agent_id: string;
  conversation_id: string;
  acting_user_id?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNewConversationCreateMessageInput(parsed: unknown): boolean {
  if (!isRecord(parsed) || parsed.type !== "input") {
    return false;
  }
  if (!isRecord(parsed.runtime) || !isRecord(parsed.payload)) {
    return false;
  }
  return (
    parsed.payload.kind === "create_message" &&
    parsed.runtime.conversation_id === NEW_CONVERSATION_TARGET
  );
}

export async function resolveCreateMessageRuntimeScope(
  runtimeScope: InputRuntimeScope,
): Promise<InputRuntimeScope> {
  if (runtimeScope.conversation_id !== NEW_CONVERSATION_TARGET) {
    return runtimeScope;
  }

  const conversation = await getBackend().createConversation(
    { agent_id: runtimeScope.agent_id },
    actingUserRequestOptions(runtimeScope.acting_user_id),
  );
  return { ...runtimeScope, conversation_id: conversation.id };
}
