import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  LettaStreamingResponse,
  Message,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import type {
  AgentMessageListBody,
  AgentUpdateBody,
  ConversationCreateBody,
  ConversationMessageCreateBody,
  ConversationMessageListBody,
  ConversationMessageStreamBody,
  ConversationUpdateBody,
} from "../backend";
import type {
  ProviderTrajectoryMessage,
  ProviderTrajectoryUIMessage,
} from "./ProviderTrajectory";

export type StoredMessage = Message & {
  id: string;
  message_type: string;
  date: string;
  content?: unknown;
  agent_id: string;
  conversation_id: string;
};

type StoredConversation = Conversation & {
  id: string;
  agent_id: string;
  in_context_message_ids: string[];
};

function createAgent(agentId: string): AgentState {
  return {
    id: agentId,
    name: "Fake Headless Agent",
    tools: [],
    tags: [],
    message_ids: [],
    in_context_message_ids: [],
    llm_config: {
      model: "dev/fake-headless",
      model_endpoint_type: "openai",
      model_endpoint: "https://example.invalid/v1",
      context_window: 128000,
    },
  } as unknown as AgentState;
}

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

function normalizeContent(content: unknown): unknown {
  if (typeof content === "string") {
    return textContent(content);
  }
  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!isRecord(part)) return "";
        if (part.type === "text" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter((text) => text.length > 0)
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

function parseToolInput(input: unknown): unknown {
  if (typeof input !== "string") return input ?? {};
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function getMessageType(message: Record<string, unknown>): string {
  if (message.type === "approval") {
    return "approval_response_message";
  }
  if (message.role === "assistant") {
    return "assistant_message";
  }
  return "user_message";
}

function getListLimit(
  body?: ConversationMessageListBody | AgentMessageListBody,
) {
  const limit = (body as { limit?: unknown } | undefined)?.limit;
  return typeof limit === "number" && limit > 0 ? limit : undefined;
}

function getListOrder(
  body?: ConversationMessageListBody | AgentMessageListBody,
) {
  const order = (body as { order?: unknown } | undefined)?.order;
  return order === "asc" ? "asc" : "desc";
}

function getCursor(
  body: ConversationMessageListBody | AgentMessageListBody | undefined,
  key: "before" | "after",
): string | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toStoredOutputFields(chunk: Record<string, unknown>) {
  const { id: _id, date: _date, agent_id, conversation_id, ...fields } = chunk;
  void agent_id;
  void conversation_id;
  return fields;
}

export interface StoredTurnInput {
  agentId: string;
  conversationId: string;
}

type ProviderUIMessagePart = ProviderTrajectoryUIMessage["parts"][number];
type ProviderUIToolPart = ProviderUIMessagePart & {
  type: `tool-${string}`;
  toolCallId: string;
};

function isProviderUIToolPart(
  part: ProviderUIMessagePart,
): part is ProviderUIToolPart {
  return (
    typeof part.type === "string" &&
    part.type.startsWith("tool-") &&
    "toolCallId" in part &&
    typeof part.toolCallId === "string"
  );
}

export class FakeHeadlessStore {
  private readonly agents = new Map<string, AgentState>();
  private readonly conversations = new Map<string, StoredConversation>();
  private readonly messagesByConversationKey = new Map<
    string,
    StoredMessage[]
  >();
  private readonly providerTrajectoryByConversationKey = new Map<
    string,
    ProviderTrajectoryMessage[]
  >();
  private readonly messagesById = new Map<string, StoredMessage[]>();
  private conversationSeq = 0;
  private messageSeq = 0;
  private providerTrajectorySeq = 0;

  constructor(private readonly defaultAgentId: string) {
    this.ensureAgent(this.defaultAgentId);
  }

  ensureAgent(agentId: string): AgentState {
    const existing = this.agents.get(agentId);
    if (existing) return existing;
    const agent = createAgent(agentId);
    this.agents.set(agentId, agent);
    this.ensureConversation("default", agentId);
    return agent;
  }

  updateAgent(agentId: string, body: AgentUpdateBody): AgentState {
    const current = this.ensureAgent(agentId);
    const updated = { ...current, ...(body as Record<string, unknown>) };
    this.agents.set(agentId, updated as AgentState);
    return updated as AgentState;
  }

  retrieveConversation(conversationId: string, agentId?: string): Conversation {
    return this.ensureConversation(conversationId, agentId);
  }

  createConversation(body: ConversationCreateBody): Conversation {
    const agentId = body.agent_id ?? this.defaultAgentId;
    this.ensureAgent(agentId);
    this.conversationSeq += 1;
    return this.ensureConversation(
      `conv-fake-headless-${this.conversationSeq}`,
      agentId,
    );
  }

  updateConversation(
    conversationId: string,
    body: ConversationUpdateBody,
  ): Conversation {
    const current = this.ensureConversation(conversationId);
    const updated = { ...current, ...(body as Record<string, unknown>) };
    this.conversations.set(
      this.conversationKey(conversationId, current.agent_id),
      updated as StoredConversation,
    );
    return updated as Conversation;
  }

  appendTurnInput(
    conversationId: string,
    body: ConversationMessageCreateBody | ConversationMessageStreamBody,
  ): StoredTurnInput {
    const bodyWithAgent = body as {
      agent_id?: string;
      messages?: Array<Record<string, unknown>>;
    };
    const agentId =
      bodyWithAgent.agent_id ?? this.agentIdForConversation(conversationId);
    this.ensureAgent(agentId);
    this.ensureConversation(conversationId, agentId);

    for (const message of bodyWithAgent.messages ?? []) {
      const storedMessage = this.appendInputMessage(
        conversationId,
        agentId,
        message,
      );
      this.appendProviderInputMessage(
        conversationId,
        agentId,
        message,
        storedMessage,
      );
    }

    return { agentId, conversationId };
  }

  appendStreamChunk(
    conversationId: string,
    agentId: string,
    chunk: LettaStreamingResponse,
  ): LettaStreamingResponse {
    const messageType = (chunk as { message_type?: unknown })?.message_type;
    if (typeof messageType !== "string" || messageType === "stop_reason") {
      return chunk;
    }

    const storedMessage = this.appendMessage(
      conversationId,
      agentId,
      toStoredOutputFields(chunk as unknown as Record<string, unknown>),
    );
    this.appendProviderOutputChunk(
      conversationId,
      agentId,
      chunk,
      storedMessage,
    );
    return storedMessage as unknown as LettaStreamingResponse;
  }

  listProviderTrajectory(
    conversationId: string,
    agentId?: string,
  ): ProviderTrajectoryMessage[] {
    const resolvedAgentId =
      agentId ?? this.agentIdForConversation(conversationId);
    this.ensureConversation(conversationId, resolvedAgentId);
    return [
      ...(this.providerTrajectoryByConversationKey.get(
        this.conversationKey(conversationId, resolvedAgentId),
      ) ?? []),
    ];
  }

  listConversationMessages(
    conversationId: string,
    body?: ConversationMessageListBody,
  ): StoredMessage[] {
    const agentId =
      (body as { agent_id?: string } | undefined)?.agent_id ??
      this.agentIdForConversation(conversationId);
    this.ensureConversation(conversationId, agentId);
    const messages = [
      ...(this.messagesByConversationKey.get(
        this.conversationKey(conversationId, agentId),
      ) ?? []),
    ];
    return this.applyListOptions(messages, body);
  }

  listAgentMessages(
    agentId: string,
    body?: AgentMessageListBody,
  ): StoredMessage[] {
    const conversationId =
      (body as { conversation_id?: string } | undefined)?.conversation_id ??
      "default";
    return this.listConversationMessages(conversationId, {
      ...(body as Record<string, unknown> | undefined),
      agent_id: agentId,
    } as ConversationMessageListBody);
  }

  retrieveMessage(messageId: string): StoredMessage[] {
    return [...(this.messagesById.get(messageId) ?? [])];
  }

  private appendProviderInputMessage(
    conversationId: string,
    agentId: string,
    message: Record<string, unknown>,
    storedMessage: StoredMessage,
  ): void {
    if (message.type === "approval") {
      this.applyApprovalResultsToProviderTrajectory(
        conversationId,
        agentId,
        Array.isArray(message.approvals) ? message.approvals : [],
        storedMessage,
      );
      return;
    }

    if (message.role === "user") {
      const text = textFromContent(normalizeContent(message.content));
      if (text.length > 0) {
        this.appendProviderTrajectoryMessage(conversationId, agentId, {
          storedMessage,
          role: "user",
          parts: [{ type: "text", text }],
        });
      }
    }
  }

  private appendProviderOutputChunk(
    conversationId: string,
    agentId: string,
    chunk: LettaStreamingResponse,
    storedMessage: StoredMessage,
  ): void {
    if (chunk.message_type === "assistant_message") {
      const content = (chunk as { content?: unknown }).content;
      const parts = Array.isArray(content)
        ? content
        : textContent(textFromContent(content));
      for (const part of parts) {
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string") {
          this.appendAssistantTextProviderMessage(
            conversationId,
            agentId,
            part.text,
            storedMessage,
            typeof (chunk as { otid?: unknown }).otid === "string"
              ? (chunk as { otid: string }).otid
              : undefined,
          );
          continue;
        }
        if (part.type === "reasoning" && typeof part.text === "string") {
          this.appendAssistantReasoningProviderMessage(
            conversationId,
            agentId,
            part.text,
            storedMessage,
            typeof (chunk as { otid?: unknown }).otid === "string"
              ? (chunk as { otid: string }).otid
              : undefined,
          );
        }
      }
      return;
    }

    if (chunk.message_type === "approval_request_message") {
      const toolCall = this.toolCallFromChunk(chunk);
      if (toolCall) {
        this.appendAssistantToolCallProviderMessage(
          conversationId,
          agentId,
          toolCall,
          storedMessage,
        );
      }
    }
  }

  private appendProviderTrajectoryMessage(
    conversationId: string,
    agentId: string,
    options: {
      storedMessage: StoredMessage;
      role: ProviderTrajectoryUIMessage["role"];
      parts: ProviderUIMessagePart[];
      otid?: string;
      toolCallIds?: string[];
      approvalRequestId?: string;
      approvalResponseId?: string;
    },
  ): ProviderTrajectoryMessage {
    this.providerTrajectorySeq += 1;
    const id = `provider-msg-fake-headless-${this.providerTrajectorySeq}`;
    const entry: ProviderTrajectoryMessage = {
      type: "letta_provider_ui_message",
      schemaVersion: 1,
      id,
      date: options.storedMessage.date,
      agentId,
      conversationId,
      uiMessage: {
        id,
        role: options.role,
        metadata: {
          lettaProjection: {
            messageTypes: [options.storedMessage.message_type],
            otids: options.otid ? [options.otid] : undefined,
            messageIds: [options.storedMessage.id],
            approvalRequestIds: options.approvalRequestId
              ? [options.approvalRequestId]
              : undefined,
            approvalResponseIds: options.approvalResponseId
              ? [options.approvalResponseId]
              : undefined,
            toolCallIds: options.toolCallIds,
          },
        },
        parts: options.parts,
      },
    };
    const key = this.conversationKey(conversationId, agentId);
    const trajectory = this.providerTrajectoryByConversationKey.get(key) ?? [];
    trajectory.push(entry);
    this.providerTrajectoryByConversationKey.set(key, trajectory);
    return entry;
  }

  private appendAssistantTextProviderMessage(
    conversationId: string,
    agentId: string,
    text: string,
    storedMessage: StoredMessage,
    otid?: string,
  ): void {
    const entry = this.assistantEntryForAppend(
      conversationId,
      agentId,
      storedMessage,
      otid,
    );
    const lastPart = entry.uiMessage.parts.at(-1);
    if (lastPart?.type === "text") {
      lastPart.text += text;
    } else {
      entry.uiMessage.parts.push({ type: "text", text });
    }
    this.appendStoredMessageProjection(entry, storedMessage, { otid });
  }

  private appendAssistantReasoningProviderMessage(
    conversationId: string,
    agentId: string,
    text: string,
    storedMessage: StoredMessage,
    otid?: string,
  ): void {
    const entry = this.assistantEntryForAppend(
      conversationId,
      agentId,
      storedMessage,
      otid,
    );
    const lastPart = entry.uiMessage.parts.at(-1);
    if (lastPart?.type === "reasoning") {
      lastPart.text += text;
    } else {
      entry.uiMessage.parts.push({ type: "reasoning", text });
    }
    this.appendStoredMessageProjection(entry, storedMessage, { otid });
  }

  private appendAssistantToolCallProviderMessage(
    conversationId: string,
    agentId: string,
    toolCall: { toolCallId: string; toolName: string; input: unknown },
    storedMessage: StoredMessage,
  ): void {
    const entry = this.assistantEntryForAppend(
      conversationId,
      agentId,
      storedMessage,
    );
    entry.uiMessage.parts.push({
      type: `tool-${toolCall.toolName}`,
      toolCallId: toolCall.toolCallId,
      state: "approval-requested",
      input: toolCall.input,
      approval: { id: storedMessage.id },
    } as ProviderUIMessagePart);
    this.appendStoredMessageProjection(entry, storedMessage, {
      approvalRequestId: storedMessage.id,
      toolCallIds: [toolCall.toolCallId],
    });
  }

  private assistantEntryForAppend(
    conversationId: string,
    agentId: string,
    storedMessage: StoredMessage,
    otid?: string,
  ): ProviderTrajectoryMessage {
    const trajectory = this.providerTrajectoryForConversation(
      conversationId,
      agentId,
    );
    const last = trajectory.at(-1);
    if (last?.uiMessage.role === "assistant") {
      return last;
    }

    return this.appendProviderTrajectoryMessage(conversationId, agentId, {
      storedMessage,
      role: "assistant",
      parts: [],
      otid,
    });
  }

  private appendStoredMessageProjection(
    entry: ProviderTrajectoryMessage,
    storedMessage: StoredMessage,
    options: {
      otid?: string;
      toolCallIds?: string[];
      approvalRequestId?: string;
      approvalResponseId?: string;
    } = {},
  ): void {
    const projection = entry.uiMessage.metadata?.lettaProjection;
    if (!projection) return;
    if (!projection.messageIds.includes(storedMessage.id)) {
      projection.messageIds.push(storedMessage.id);
    }
    if (!projection.messageTypes.includes(storedMessage.message_type)) {
      projection.messageTypes.push(storedMessage.message_type);
    }
    if (options.otid) {
      projection.otids = [...(projection.otids ?? []), options.otid];
    }
    if (options.toolCallIds && options.toolCallIds.length > 0) {
      projection.toolCallIds = [
        ...(projection.toolCallIds ?? []),
        ...options.toolCallIds,
      ];
    }
    if (options.approvalRequestId) {
      projection.approvalRequestIds = [
        ...(projection.approvalRequestIds ?? []),
        options.approvalRequestId,
      ];
    }
    if (options.approvalResponseId) {
      projection.approvalResponseIds = [
        ...(projection.approvalResponseIds ?? []),
        options.approvalResponseId,
      ];
    }
  }

  private providerTrajectoryForConversation(
    conversationId: string,
    agentId: string,
  ): ProviderTrajectoryMessage[] {
    const key = this.conversationKey(conversationId, agentId);
    const trajectory = this.providerTrajectoryByConversationKey.get(key) ?? [];
    this.providerTrajectoryByConversationKey.set(key, trajectory);
    return trajectory;
  }

  private toolCallFromChunk(
    chunk: LettaStreamingResponse,
  ): { toolCallId: string; toolName: string; input: unknown } | undefined {
    const chunkWithTools = chunk as unknown as {
      tool_call?: unknown;
      tool_calls?: unknown;
    };
    const toolCall =
      (isRecord(chunkWithTools.tool_call) && chunkWithTools.tool_call) ||
      (Array.isArray(chunkWithTools.tool_calls) &&
      isRecord(chunkWithTools.tool_calls[0])
        ? chunkWithTools.tool_calls[0]
        : undefined);
    if (!toolCall) return undefined;
    const toolCallId = toolCall.tool_call_id;
    const toolName = toolCall.name;
    if (typeof toolCallId !== "string" || typeof toolName !== "string") {
      return undefined;
    }
    return {
      toolCallId,
      toolName,
      input: parseToolInput(toolCall.arguments),
    };
  }

  private applyApprovalResultsToProviderTrajectory(
    conversationId: string,
    agentId: string,
    approvals: unknown[],
    storedMessage: StoredMessage,
  ): void {
    for (const approval of approvals) {
      if (!isRecord(approval)) continue;
      const toolCallId = approval.tool_call_id;
      if (typeof toolCallId !== "string") continue;
      const match = this.findToolUIPart(conversationId, agentId, toolCallId);
      if (!match) continue;

      if (approval.type === "approval" && approval.approve === false) {
        delete (match.part as { approval?: unknown }).approval;
        Object.assign(match.part, {
          state: "output-error",
          errorText:
            typeof approval.reason === "string"
              ? approval.reason
              : "Tool execution denied.",
        });
        this.appendStoredMessageProjection(match.entry, storedMessage, {
          approvalResponseId: storedMessage.id,
        });
        continue;
      }

      if (approval.type !== "tool") continue;
      delete (match.part as { approval?: unknown }).approval;
      Object.assign(match.part, {
        state: "output-available",
        output: textFromContent(approval.tool_return),
      });
      this.appendStoredMessageProjection(match.entry, storedMessage, {
        approvalResponseId: storedMessage.id,
      });
    }
  }

  private findToolUIPart(
    conversationId: string,
    agentId: string,
    toolCallId: string,
  ):
    | { entry: ProviderTrajectoryMessage; part: ProviderUIToolPart }
    | undefined {
    const trajectory = this.providerTrajectoryForConversation(
      conversationId,
      agentId,
    );
    for (
      let entryIndex = trajectory.length - 1;
      entryIndex >= 0;
      entryIndex--
    ) {
      const entry = trajectory[entryIndex];
      if (!entry) continue;
      if (entry.uiMessage.role !== "assistant") continue;
      for (
        let partIndex = entry.uiMessage.parts.length - 1;
        partIndex >= 0;
        partIndex--
      ) {
        const part = entry.uiMessage.parts[partIndex];
        if (!part) continue;
        if (isProviderUIToolPart(part) && part.toolCallId === toolCallId) {
          return { entry, part };
        }
      }
    }
    return undefined;
  }

  private appendInputMessage(
    conversationId: string,
    agentId: string,
    message: Record<string, unknown>,
  ): StoredMessage {
    const content =
      message.type === "approval"
        ? (message.approvals ?? [])
        : normalizeContent(message.content);
    return this.appendMessage(conversationId, agentId, {
      message_type: getMessageType(message),
      role: message.role,
      content,
      otid: message.otid,
      approvals: message.approvals,
    });
  }

  private appendMessage(
    conversationId: string,
    agentId: string,
    fields: Record<string, unknown>,
  ): StoredMessage {
    const conversation = this.ensureConversation(conversationId, agentId);
    this.messageSeq += 1;
    const id = `msg-fake-headless-${this.messageSeq}`;
    const message = {
      id,
      date: new Date(Date.UTC(2026, 0, 1, 0, 0, this.messageSeq)).toISOString(),
      agent_id: agentId,
      conversation_id: conversation.id,
      ...fields,
    } as StoredMessage;

    const key = this.conversationKey(conversation.id, agentId);
    const messages = this.messagesByConversationKey.get(key) ?? [];
    messages.push(message);
    this.messagesByConversationKey.set(key, messages);
    this.messagesById.set(id, [message]);

    conversation.in_context_message_ids = [
      ...conversation.in_context_message_ids,
      id,
    ];
    this.conversations.set(key, conversation);

    const agent = this.ensureAgent(agentId);
    const agentWithContext = agent as AgentState & {
      in_context_message_ids?: string[];
    };
    const messageIds = [...(agent.message_ids ?? []), id];
    const inContextMessageIds = [
      ...(agentWithContext.in_context_message_ids ?? []),
      id,
    ];
    this.agents.set(agentId, {
      ...agent,
      message_ids: messageIds,
      in_context_message_ids: inContextMessageIds,
    } as AgentState);

    return message;
  }

  private applyListOptions(
    messages: StoredMessage[],
    body?: ConversationMessageListBody | AgentMessageListBody,
  ): StoredMessage[] {
    let items = messages;
    const before = getCursor(body, "before");
    if (before) {
      const beforeIndex = items.findIndex((message) => message.id === before);
      if (beforeIndex >= 0) {
        items = items.slice(0, beforeIndex);
      }
    }

    const after = getCursor(body, "after");
    if (after) {
      const afterIndex = items.findIndex((message) => message.id === after);
      if (afterIndex >= 0) {
        items = items.slice(afterIndex + 1);
      }
    }

    if (getListOrder(body) === "desc") {
      items = [...items].reverse();
    } else {
      items = [...items];
    }

    const limit = getListLimit(body);
    return limit === undefined ? items : items.slice(0, limit);
  }

  private ensureConversation(
    conversationId: string,
    agentId?: string,
  ): StoredConversation {
    const resolvedAgentId = agentId ?? this.defaultAgentId;
    const key = this.conversationKey(conversationId, resolvedAgentId);
    const existing = this.conversations.get(key);
    if (existing) return existing;

    const conversation = {
      id: conversationId,
      agent_id: resolvedAgentId,
      in_context_message_ids: [],
    } as StoredConversation;
    this.conversations.set(key, conversation);
    this.messagesByConversationKey.set(key, []);
    this.providerTrajectoryByConversationKey.set(key, []);
    return conversation;
  }

  private agentIdForConversation(conversationId: string): string {
    if (conversationId === "default") return this.defaultAgentId;
    for (const conversation of this.conversations.values()) {
      if (conversation.id === conversationId) {
        return conversation.agent_id;
      }
    }
    return this.defaultAgentId;
  }

  private conversationKey(conversationId: string, agentId: string): string {
    return conversationId === "default"
      ? `default:${agentId}`
      : `conversation:${conversationId}`;
  }
}
