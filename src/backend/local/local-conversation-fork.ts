import type { LocalAssistantMessage, LocalMessage } from "./local-message";
import { projectLocalMessageToStoredMessages } from "./local-message-projection";

const FORK_PROJECTION_FALLBACK_DATE = "1970-01-01T00:00:00.000Z";

function projectMessage(
  message: LocalMessage,
  agentId: string,
  conversationId: string,
) {
  return projectLocalMessageToStoredMessages(
    message,
    agentId,
    conversationId,
    FORK_PROJECTION_FALLBACK_DATE,
  );
}

function truncateAssistantThroughProjectedMessage(
  message: LocalAssistantMessage,
  projectedMessageId: string,
  agentId: string,
  conversationId: string,
): LocalAssistantMessage {
  const selectedProjection = projectMessage(
    message,
    agentId,
    conversationId,
  ).find((projected) => projected.id === projectedMessageId);
  if (!selectedProjection) return message;
  const selectedJson = JSON.stringify(selectedProjection);

  for (let end = 1; end <= message.content.length; end += 1) {
    const candidate = { ...message, content: message.content.slice(0, end) };
    const candidateProjection = projectMessage(
      candidate,
      agentId,
      conversationId,
    );
    const selectedCandidate = candidateProjection.find(
      (projected) => projected.id === projectedMessageId,
    );
    if (
      candidateProjection.at(-1)?.id === projectedMessageId &&
      JSON.stringify(selectedCandidate) === selectedJson
    ) {
      return candidate;
    }
  }

  return message;
}

export function selectLocalMessagesForFork(
  messages: LocalMessage[],
  messageId: string | undefined,
  agentId: string,
  conversationId: string,
): LocalMessage[] | undefined {
  if (!messageId) return messages;

  for (let sourceIndex = 0; sourceIndex < messages.length; sourceIndex += 1) {
    const sourceMessage = messages[sourceIndex];
    if (!sourceMessage) continue;
    const projected = projectMessage(sourceMessage, agentId, conversationId);
    const projectedIndex = projected.findIndex(
      (message) => message.id === messageId,
    );
    if (projectedIndex < 0) continue;

    if (
      sourceMessage.role !== "assistant" ||
      projectedIndex === projected.length - 1
    ) {
      return messages.slice(0, sourceIndex + 1);
    }
    return [
      ...messages.slice(0, sourceIndex),
      truncateAssistantThroughProjectedMessage(
        sourceMessage,
        messageId,
        agentId,
        conversationId,
      ),
    ];
  }

  return undefined;
}
