import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
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

type StoredMessage = Message & {
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

export class FakeHeadlessStore {
  private readonly agents = new Map<string, AgentState>();
  private readonly conversations = new Map<string, StoredConversation>();
  private readonly messagesByConversationKey = new Map<
    string,
    StoredMessage[]
  >();
  private readonly messagesById = new Map<string, StoredMessage[]>();
  private conversationSeq = 0;
  private messageSeq = 0;

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

  appendTurn(
    conversationId: string,
    body: ConversationMessageCreateBody | ConversationMessageStreamBody,
  ): StoredMessage {
    const bodyWithAgent = body as {
      agent_id?: string;
      messages?: Array<Record<string, unknown>>;
    };
    const agentId =
      bodyWithAgent.agent_id ?? this.agentIdForConversation(conversationId);
    this.ensureAgent(agentId);
    this.ensureConversation(conversationId, agentId);

    for (const message of bodyWithAgent.messages ?? []) {
      this.appendInputMessage(conversationId, agentId, message);
    }

    return this.appendAssistantMessage(conversationId, agentId, "pong");
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

  private appendAssistantMessage(
    conversationId: string,
    agentId: string,
    text: string,
  ): StoredMessage {
    return this.appendMessage(conversationId, agentId, {
      message_type: "assistant_message",
      role: "assistant",
      content: textContent(text),
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
