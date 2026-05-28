import type {
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import type {
  LocalAssistantMessage,
  LocalMessage,
  LocalToolCall,
  LocalToolResultMessage,
  LocalUserMessage,
} from "./local-message";
import type { StoredMessage } from "./local-types";

type AssistantContent = LocalAssistantMessage["content"][number];

export function isLocalToolCallContent(
  content: AssistantContent,
): content is LocalToolCall {
  return content.type === "toolCall" && typeof content.id === "string";
}

function isTextContent(content: AssistantContent): content is TextContent {
  return content.type === "text" && typeof content.text === "string";
}

function isThinkingContent(
  content: AssistantContent,
): content is ThinkingContent {
  return content.type === "thinking" && typeof content.thinking === "string";
}

function customToolCallInput(content: ToolCall): string | undefined {
  const customContent = content as { input?: unknown; customInput?: unknown };
  if (typeof customContent.input === "string") return customContent.input;
  if (typeof customContent.customInput === "string") {
    return customContent.customInput;
  }
  return undefined;
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

function isoFromTimestamp(value: number | undefined): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;
}

function localMessageDate(message: LocalMessage, fallbackDate: string): string {
  return (
    (typeof message.metadata?.created_at === "string"
      ? message.metadata.created_at
      : undefined) ??
    isoFromTimestamp(message.timestamp) ??
    fallbackDate
  );
}

function offsetIsoTimestamp(value: string, offsetMs: number): string {
  if (offsetMs === 0) return value;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed + offsetMs).toISOString();
}

function userContentToStoredContent(
  content: LocalUserMessage["content"],
): unknown {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: part.mimeType,
        data: part.data,
      },
    };
  });
}

function toolResultToStoredReturnValue(
  message: LocalToolResultMessage,
): unknown {
  if (message.content.length === 1 && message.content[0]?.type === "text") {
    return message.content[0].text;
  }
  return message.content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: part.mimeType,
        data: part.data,
      },
    };
  });
}

function projectThinkingContent(
  message: LocalAssistantMessage,
  content: ThinkingContent,
  contentIndex: number,
  date: string,
  agentId: string,
  conversationId: string,
): StoredMessage | undefined {
  if (content.thinking.length === 0) return undefined;
  return {
    id: `${message.id}:reasoning:${contentIndex}`,
    date,
    agent_id: agentId,
    conversation_id: conversationId,
    message_type: "reasoning_message",
    reasoning: content.thinking,
  } as StoredMessage;
}

function projectToolCallContent(
  message: LocalAssistantMessage,
  content: ToolCall,
  date: string,
  agentId: string,
  conversationId: string,
): StoredMessage {
  const customInput = customToolCallInput(content);
  const argumentsPayload =
    customInput !== undefined
      ? { input: customInput }
      : (content.arguments ?? {});
  return {
    id: `${message.id}:tool:${content.id}:request`,
    date,
    agent_id: agentId,
    conversation_id: conversationId,
    message_type: "approval_request_message",
    tool_call: {
      tool_call_id: content.id,
      name: content.name,
      arguments: JSON.stringify(argumentsPayload),
      ...(customInput !== undefined
        ? { type: "custom", input: customInput }
        : {}),
    },
  } as StoredMessage;
}

function projectToolResultMessage(
  message: LocalToolResultMessage,
  fallbackAgentId: string,
  fallbackConversationId: string,
  fallbackDate: string,
): StoredMessage {
  const agentId = localMessageAgentId(message, fallbackAgentId);
  const conversationId = localMessageConversationId(
    message,
    fallbackConversationId,
  );
  return {
    id: message.id,
    date: fallbackDate,
    agent_id: agentId,
    conversation_id: conversationId,
    message_type: "tool_return_message",
    tool_call_id: message.toolCallId,
    status: message.isError ? "error" : "success",
    tool_return: toolResultToStoredReturnValue(message),
  } as StoredMessage;
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
  const date = localMessageDate(message, fallbackDate);

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

  if (message.role === "user") {
    return [
      {
        id: message.id,
        date,
        agent_id: agentId,
        conversation_id: conversationId,
        message_type: "user_message",
        role: "user",
        content: userContentToStoredContent(message.content),
      } as StoredMessage,
    ];
  }

  if (message.role === "toolResult") {
    return [
      projectToolResultMessage(
        message,
        fallbackAgentId,
        fallbackConversationId,
        date,
      ),
    ];
  }

  const messages: StoredMessage[] = [];
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

  for (
    let contentIndex = 0;
    contentIndex < message.content.length;
    contentIndex++
  ) {
    const content = message.content[contentIndex];
    if (!content) continue;

    if (isThinkingContent(content)) {
      flushPendingText();
      const reasoningMessage = projectThinkingContent(
        message,
        content,
        contentIndex,
        date,
        agentId,
        conversationId,
      );
      if (reasoningMessage) messages.push(reasoningMessage);
      continue;
    }

    if (isLocalToolCallContent(content)) {
      flushPendingText();
      messages.push(
        projectToolCallContent(message, content, date, agentId, conversationId),
      );
      continue;
    }

    if (isTextContent(content)) {
      if (pendingTextStartIndex === -1) pendingTextStartIndex = contentIndex;
      pendingTextContent.push({ type: "text", text: content.text });
    }
  }

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
  _sourceMessageIndex: number,
): StoredMessage[] {
  return messages.map(
    (message, projectedIndex) =>
      ({
        ...message,
        date: offsetIsoTimestamp(message.date, projectedIndex),
      }) as StoredMessage,
  );
}

export function projectedMessageLookupKeys(
  sourceMessage: LocalMessage,
  projected: StoredMessage[],
): Array<[string, StoredMessage[]]> {
  const keys: Array<[string, StoredMessage[]]> = [];
  if (projected.length > 0) keys.push([sourceMessage.id, projected]);
  for (const message of projected) keys.push([message.id, [message]]);
  return keys;
}

export function cloneLocalMessage(message: LocalMessage): LocalMessage {
  try {
    return structuredClone(message) as LocalMessage;
  } catch {
    return JSON.parse(JSON.stringify(message)) as LocalMessage;
  }
}

export function mergeSnapshotContentWithExistingToolCalls(
  snapshotContent: LocalAssistantMessage["content"],
  existingContent: LocalAssistantMessage["content"],
): LocalAssistantMessage["content"] {
  const snapshotToolIds = new Set(
    snapshotContent.filter(isLocalToolCallContent).map((content) => content.id),
  );
  const missingExistingTools = existingContent.filter(
    (content) =>
      isLocalToolCallContent(content) && !snapshotToolIds.has(content.id),
  );
  return [...snapshotContent, ...missingExistingTools];
}

export function findToolResultForCall(
  messages: LocalMessage[],
  toolCallId: string,
): LocalToolResultMessage | undefined {
  return messages.find(
    (message): message is LocalToolResultMessage =>
      message.role === "toolResult" && message.toolCallId === toolCallId,
  );
}
