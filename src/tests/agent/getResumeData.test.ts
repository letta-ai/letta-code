import { afterEach, describe, expect, mock, test } from "bun:test";
import type Letta from "@letta-ai/letta-client";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  Message,
  MessageType,
} from "@letta-ai/letta-client/resources/agents/messages";
import { getResumeData } from "../../agent/check-approval";
import { __testSetBackend, type Backend } from "../../backend";

type ResumeAgentState = AgentState & {
  in_context_message_ids?: string[] | null;
};

const dummyClient = {} as Letta;

function installBackend(overrides: Record<string, unknown>): void {
  __testSetBackend(overrides as unknown as Backend);
}

const RESUME_BACKFILL_MESSAGE_TYPES: MessageType[] = [
  "user_message",
  "assistant_message",
  "reasoning_message",
  "event_message",
  "summary_message",
];

const DEFAULT_RESUME_MESSAGE_TYPES: MessageType[] = [
  ...RESUME_BACKFILL_MESSAGE_TYPES,
  "approval_request_message",
  "approval_response_message",
];

function makeAgent(overrides: Partial<ResumeAgentState> = {}): AgentState {
  return {
    id: "agent-test",
    message_ids: ["msg-last"],
    ...overrides,
  } as ResumeAgentState;
}

function makeApprovalMessage(id = "msg-last"): Message {
  return {
    id,
    date: new Date().toISOString(),
    message_type: "approval_request_message",
    tool_calls: [
      {
        tool_call_id: "tool-1",
        name: "Bash",
        arguments: '{"command":"echo hi"}',
      },
    ],
  } as unknown as Message;
}

function makeUserMessage(id = "msg-last"): Message {
  return {
    id,
    date: new Date().toISOString(),
    message_type: "user_message",
  } as Message;
}

describe("getResumeData", () => {
  afterEach(() => {
    __testSetBackend(null);
  });

  test("includeMessageHistory=false still computes pending approvals without backfill (conversation path)", async () => {
    const conversationsRetrieve = mock(async () => ({
      in_context_message_ids: ["msg-last"],
    }));
    const conversationsList = mock(async () => ({
      getPaginatedItems: () => [],
    }));
    const agentsList = mock(async () => ({ items: [] }));
    const messagesRetrieve = mock(async () => [makeApprovalMessage()]);

    installBackend({
      retrieveConversation: conversationsRetrieve,
      listConversationMessages: conversationsList,
      listAgentMessages: agentsList,
      retrieveMessage: messagesRetrieve,
    });

    const resume = await getResumeData(dummyClient, makeAgent(), "conv-abc", {
      includeMessageHistory: false,
    });

    expect(conversationsRetrieve).toHaveBeenCalledTimes(1);
    expect(messagesRetrieve).toHaveBeenCalledTimes(1);
    expect(conversationsList).toHaveBeenCalledTimes(0);
    expect(resume.pendingApprovals).toHaveLength(1);
    expect(resume.pendingApprovals[0]?.toolName).toBe("Bash");
    expect(resume.messageHistory).toEqual([]);
  });

  test("includeMessageHistory=false skips default-conversation backfill calls", async () => {
    const conversationsRetrieve = mock(async () => ({
      in_context_message_ids: ["msg-last"],
    }));
    const conversationsList = mock(async () => ({
      getPaginatedItems: () => [],
    }));
    const agentsList = mock(async () => ({
      getPaginatedItems: () => [makeApprovalMessage()],
    }));
    const messagesRetrieve = mock(async () => [makeApprovalMessage()]);

    installBackend({
      retrieveConversation: conversationsRetrieve,
      listConversationMessages: conversationsList,
      listAgentMessages: agentsList,
      retrieveMessage: messagesRetrieve,
    });

    const resume = await getResumeData(
      dummyClient,
      makeAgent({
        message_ids: ["msg-last"],
        in_context_message_ids: ["msg-last"],
      }),
      "default",
      { includeMessageHistory: false },
    );

    expect(messagesRetrieve).toHaveBeenCalledTimes(1);
    expect(agentsList).toHaveBeenCalledTimes(0);
    expect(resume.pendingApprovals).toHaveLength(1);
    expect(resume.messageHistory).toEqual([]);
  });

  test("default conversation resume uses in-context ids instead of stale agent.message_ids", async () => {
    const agentsList = mock(async () => ({
      getPaginatedItems: () => [makeApprovalMessage("msg-default-latest")],
    }));
    const messagesRetrieve = mock(async () => [
      makeApprovalMessage("msg-live"),
    ]);

    installBackend({
      listAgentMessages: agentsList,
      retrieveMessage: messagesRetrieve,
    });

    const resume = await getResumeData(
      dummyClient,
      makeAgent({
        message_ids: ["msg-stale"],
        in_context_message_ids: ["msg-live"],
      }),
      "default",
      { includeMessageHistory: false },
    );

    expect(messagesRetrieve).toHaveBeenCalledWith("msg-live");
    expect(messagesRetrieve).toHaveBeenCalledTimes(1);
    expect(agentsList).toHaveBeenCalledTimes(0);
    expect(resume.pendingApprovals).toHaveLength(1);
    expect(resume.pendingApprovals[0]?.toolCallId).toBe("tool-1");
  });

  test("default conversation falls back to default conversation stream when in-context ids are unavailable", async () => {
    const agentsList = mock(async () => ({
      getPaginatedItems: () => [makeApprovalMessage("msg-default-latest")],
    }));
    const messagesRetrieve = mock(async () => [makeUserMessage("msg-stale")]);

    installBackend({
      listAgentMessages: agentsList,
      retrieveMessage: messagesRetrieve,
    });

    const resume = await getResumeData(
      dummyClient,
      makeAgent({ in_context_message_ids: [] }),
      "default",
      { includeMessageHistory: false },
    );

    expect(messagesRetrieve).toHaveBeenCalledTimes(0);
    expect(agentsList).toHaveBeenCalledTimes(1);
    expect(resume.pendingApprovals).toHaveLength(1);
    expect(resume.pendingApprovals[0]?.toolCallId).toBe("tool-1");
  });

  test("default behavior keeps backfill enabled when options are omitted", async () => {
    const conversationsRetrieve = mock(async () => ({
      in_context_message_ids: ["msg-last"],
    }));
    const agentsList = mock(async () => ({
      getPaginatedItems: () => [
        makeUserMessage("msg-a"),
        makeUserMessage("msg-b"),
      ],
    }));
    const messagesRetrieve = mock(async () => [makeUserMessage()]);

    installBackend({
      retrieveConversation: conversationsRetrieve,
      listAgentMessages: agentsList,
      retrieveMessage: messagesRetrieve,
    });

    const resume = await getResumeData(
      dummyClient,
      makeAgent({ in_context_message_ids: ["msg-last"] }),
      "default",
    );

    expect(messagesRetrieve).toHaveBeenCalledTimes(1);
    expect(agentsList).toHaveBeenCalledTimes(1);
    expect(agentsList).toHaveBeenCalledWith("agent-test", {
      conversation_id: "default",
      limit: 200,
      order: "desc",
      include_return_message_types: DEFAULT_RESUME_MESSAGE_TYPES,
    });
    expect(resume.pendingApprovals).toHaveLength(0);
    expect(resume.messageHistory.length).toBeGreaterThan(0);
  });
});
