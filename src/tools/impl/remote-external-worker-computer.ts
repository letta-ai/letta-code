import { getClient } from "@/backend/api/client";
import {
  type AgentSandboxOptions,
  resolveAgentSandboxConnectionId,
  resolveEnvironmentConnectionId,
} from "@/backend/api/environments";
import { isCloudEnvironmentSelector } from "@/headless-environment-response";

export async function resolveExternalWorkerComputer(
  computer: string,
  scope: { agentId: string; conversationId: string },
  cloudOptions?: AgentSandboxOptions,
) {
  if (!isCloudEnvironmentSelector(computer))
    return resolveEnvironmentConnectionId(computer);

  const client = await getClient();
  const parentConversationId =
    scope.conversationId && scope.conversationId !== "default"
      ? scope.conversationId
      : undefined;
  const createParams = {
    agent_id: scope.agentId,
    hidden: true,
    ...(parentConversationId
      ? { parent_conversation_id: parentConversationId }
      : {}),
  };
  const conversation = await client.conversations
    .create(createParams)
    .catch((error: unknown) => {
      if (
        !parentConversationId ||
        !error ||
        typeof error !== "object" ||
        !("status" in error) ||
        error.status !== 403
      ) {
        throw error;
      }
      const fallbackParams = { agent_id: scope.agentId, hidden: true };
      return client.conversations.create(fallbackParams);
    });
  return resolveAgentSandboxConnectionId(scope.agentId, {
    ...cloudOptions,
    conversationId: conversation.id,
  });
}
