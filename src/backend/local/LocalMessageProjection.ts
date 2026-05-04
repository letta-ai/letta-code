import type { LocalMessage } from "./LocalMessage";
import type { StoredMessage } from "./LocalStore";

type LocalMessagePart = LocalMessage["parts"][number];
type LocalToolPart = LocalMessagePart & {
  type: `tool-${string}`;
  toolCallId: string;
};
type LocalTextPart = LocalMessagePart & {
  type: "text";
  text: string;
  providerMetadata?: unknown;
};
type LocalReasoningPart = LocalMessagePart & {
  type: "reasoning";
  text: string;
  providerMetadata?: unknown;
};
type LocalFileOrSourcePart = LocalMessagePart & {
  type: "file" | "source-url" | "source-document";
};

export function isLocalToolPart(part: LocalMessagePart): part is LocalToolPart {
  return (
    typeof part.type === "string" &&
    part.type.startsWith("tool-") &&
    "toolCallId" in part &&
    typeof part.toolCallId === "string"
  );
}

function isTextOrReasoningPart(
  part: LocalMessagePart,
): part is LocalTextPart | LocalReasoningPart {
  return (
    (part.type === "text" || part.type === "reasoning") &&
    "text" in part &&
    typeof part.text === "string"
  );
}

function isFileOrSourcePart(
  part: LocalMessagePart,
): part is LocalFileOrSourcePart {
  return (
    part.type === "file" ||
    part.type === "source-url" ||
    part.type === "source-document"
  );
}

function textPartToContentPart(part: LocalTextPart) {
  return {
    type: part.type,
    text: part.text,
    ...(part.providerMetadata !== undefined && {
      providerMetadata: part.providerMetadata,
    }),
  };
}

function localToolName(part: LocalToolPart): string {
  return part.type.slice("tool-".length);
}

function stringifyToolArguments(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input ?? {});
}

function isToolOutputState(state: unknown): boolean {
  return (
    state === "output-available" ||
    state === "output-error" ||
    state === "output-denied"
  );
}

function localMessageAgentId(
  message: LocalMessage,
  fallbackAgentId: string,
): string {
  return typeof message.metadata?.agent_id === "string"
    ? message.metadata.agent_id
    : fallbackAgentId;
}

function localMessageConversationId(
  message: LocalMessage,
  fallbackConversationId: string,
): string {
  return typeof message.metadata?.conversation_id === "string"
    ? message.metadata.conversation_id
    : fallbackConversationId;
}

function projectedAssistantContent(message: LocalMessage): unknown[] {
  const content: unknown[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && isTextOrReasoningPart(part)) {
      content.push(textPartToContentPart(part));
      continue;
    }
    if (isFileOrSourcePart(part)) {
      content.push(part);
    }
  }
  return content;
}

function projectReasoningPart(
  message: LocalMessage,
  part: LocalReasoningPart,
  partIndex: number,
  date: string,
  agentId: string,
  conversationId: string,
): StoredMessage | undefined {
  if (part.text.length === 0) return undefined;
  return {
    id: `${message.id}:reasoning:${partIndex}`,
    date,
    agent_id: agentId,
    conversation_id: conversationId,
    message_type: "reasoning_message",
    reasoning: part.text,
  } as StoredMessage;
}

function projectToolPart(
  message: LocalMessage,
  part: LocalToolPart,
  date: string,
  agentId: string,
  conversationId: string,
): StoredMessage[] {
  const toolCall = {
    tool_call_id: part.toolCallId,
    name: localToolName(part),
    arguments: stringifyToolArguments((part as { input?: unknown }).input),
  };

  if (!isToolOutputState((part as { state?: unknown }).state)) {
    return [
      {
        id: `${message.id}:tool:${part.toolCallId}:pending`,
        date,
        agent_id: agentId,
        conversation_id: conversationId,
        message_type: "approval_request_message",
        tool_call: toolCall,
      } as StoredMessage,
    ];
  }

  const request: StoredMessage = {
    id: `${message.id}:tool:${part.toolCallId}:request`,
    date,
    agent_id: agentId,
    conversation_id: conversationId,
    message_type: "approval_request_message",
    tool_call: toolCall,
  } as StoredMessage;

  const output = (part as { output?: unknown }).output;
  const errorText = (part as { errorText?: unknown }).errorText;
  const returnValue =
    (part as { state?: unknown }).state === "output-available"
      ? output
      : errorText;
  const response: StoredMessage = {
    id: `${message.id}:tool:${part.toolCallId}:return`,
    date,
    agent_id: agentId,
    conversation_id: conversationId,
    message_type: "tool_return_message",
    tool_call_id: part.toolCallId,
    status:
      (part as { state?: unknown }).state === "output-available"
        ? "success"
        : "error",
    tool_return: returnValue,
  } as StoredMessage;

  return [request, response];
}

export function projectLocalMessageToStoredMessages(
  message: LocalMessage,
  fallbackAgentId: string,
  fallbackConversationId: string,
  fallbackDate: string,
): StoredMessage[] {
  const agentId = localMessageAgentId(message, fallbackAgentId);
  const conversationId = localMessageConversationId(
    message,
    fallbackConversationId,
  );
  const date = fallbackDate;

  if (message.role === "user" || message.role === "system") {
    return [
      {
        id: message.id,
        date,
        agent_id: agentId,
        conversation_id: conversationId,
        message_type: "user_message",
        role: message.role,
        content: message.parts,
      } as StoredMessage,
    ];
  }

  const messages: StoredMessage[] = [];
  for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
    const part = message.parts[partIndex];
    if (!part) continue;
    if (part.type === "reasoning" && isTextOrReasoningPart(part)) {
      const reasoningMessage = projectReasoningPart(
        message,
        part,
        partIndex,
        date,
        agentId,
        conversationId,
      );
      if (reasoningMessage) messages.push(reasoningMessage);
      continue;
    }
    if (isLocalToolPart(part)) {
      messages.push(
        ...projectToolPart(message, part, date, agentId, conversationId),
      );
    }
  }

  const assistantContent = projectedAssistantContent(message);
  if (assistantContent.length > 0) {
    messages.push({
      id: messages.length > 0 ? `${message.id}:assistant` : message.id,
      date,
      agent_id: agentId,
      conversation_id: conversationId,
      message_type: "assistant_message",
      role: "assistant",
      content: assistantContent,
    } as StoredMessage);
  }

  return messages;
}

export function projectLocalMessagesToStoredMessages(
  messages: LocalMessage[],
  fallbackAgentId: string,
  fallbackConversationId: string,
): StoredMessage[] {
  return messages.flatMap((message, index) =>
    projectLocalMessageToStoredMessages(
      message,
      fallbackAgentId,
      fallbackConversationId,
      new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
    ),
  );
}

export function projectedMessageLookupKeys(
  sourceMessage: LocalMessage,
  projected: StoredMessage[],
): Array<[string, StoredMessage[]]> {
  const keys: Array<[string, StoredMessage[]]> = [];
  if (projected.length > 0) {
    keys.push([sourceMessage.id, projected]);
  }
  for (const message of projected) {
    keys.push([message.id, [message]]);
  }
  return keys;
}

export function cloneLocalMessage(message: LocalMessage): LocalMessage {
  try {
    return structuredClone(message) as LocalMessage;
  } catch {
    return JSON.parse(JSON.stringify(message)) as LocalMessage;
  }
}

export function mergeSnapshotPartsWithExistingTools(
  snapshotParts: LocalMessagePart[],
  existingParts: LocalMessagePart[],
): LocalMessagePart[] {
  const snapshotToolIds = new Set(
    snapshotParts.filter(isLocalToolPart).map((part) => part.toolCallId),
  );
  const missingToolParts = existingParts.filter(
    (part) => isLocalToolPart(part) && !snapshotToolIds.has(part.toolCallId),
  );
  if (missingToolParts.length === 0) return snapshotParts;

  const firstContentIndex = snapshotParts.findIndex(
    (part) => part.type !== "step-start",
  );
  const insertIndex =
    firstContentIndex >= 0 ? firstContentIndex : snapshotParts.length;
  return [
    ...snapshotParts.slice(0, insertIndex),
    ...missingToolParts,
    ...snapshotParts.slice(insertIndex),
  ];
}
