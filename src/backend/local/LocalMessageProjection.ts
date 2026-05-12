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

  if (message.metadata?.compaction) {
    return [
      {
        id: message.id,
        date,
        agent_id: agentId,
        conversation_id: conversationId,
        message_type: "summary_message",
        summary: message.metadata.compaction.summary,
        ...(message.metadata.compaction.stats
          ? { compaction_stats: message.metadata.compaction.stats }
          : {}),
      } as StoredMessage,
    ];
  }

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
  // Track pending text/file parts so consecutive text parts get grouped into
  // a single assistant_message rather than emitting one per part.
  let pendingTextContent: unknown[] = [];
  let pendingTextStartIndex = -1;

  const flushPendingText = () => {
    if (pendingTextContent.length === 0) return;
    const isFirst = messages.length === 0;
    messages.push({
      id: isFirst
        ? message.id
        : `${message.id}:assistant:${pendingTextStartIndex}`,
      date,
      agent_id: agentId,
      conversation_id: conversationId,
      message_type: "assistant_message",
      role: "assistant",
      content: pendingTextContent,
    } as StoredMessage);
    pendingTextContent = [];
    pendingTextStartIndex = -1;
  };

  for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
    const part = message.parts[partIndex];
    if (!part) continue;

    if (part.type === "reasoning" && isTextOrReasoningPart(part)) {
      // Flush any pending text before emitting reasoning
      flushPendingText();
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
      // Flush any pending text before emitting tool call
      flushPendingText();
      messages.push(
        ...projectToolPart(message, part, date, agentId, conversationId),
      );
      continue;
    }

    // Accumulate text and file parts
    if (part.type === "text" && isTextOrReasoningPart(part)) {
      if (pendingTextStartIndex === -1) pendingTextStartIndex = partIndex;
      pendingTextContent.push(textPartToContentPart(part));
      continue;
    }

    if (isFileOrSourcePart(part)) {
      if (pendingTextStartIndex === -1) pendingTextStartIndex = partIndex;
      pendingTextContent.push(part);
    }
  }

  // Flush any remaining text at the end of the turn
  flushPendingText();

  return messages;
}

export function projectLocalMessagesToStoredMessages(
  messages: LocalMessage[],
  fallbackAgentId: string,
  fallbackConversationId: string,
): StoredMessage[] {
  return messages.flatMap((message, index) => {
    const projected = projectLocalMessageToStoredMessages(
      message,
      fallbackAgentId,
      fallbackConversationId,
      new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
    );
    return withProjectedMessageDates(projected, index);
  });
}

export function withProjectedMessageDates(
  messages: StoredMessage[],
  sourceMessageIndex: number,
): StoredMessage[] {
  return messages.map(
    (message, projectedIndex) =>
      ({
        ...message,
        date: new Date(
          Date.UTC(2026, 0, 1, 0, 0, sourceMessageIndex + 1, projectedIndex),
        ).toISOString(),
      }) as StoredMessage,
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
