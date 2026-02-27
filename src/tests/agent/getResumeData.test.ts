import { describe, expect, mock, test } from "bun:test";
import type Letta from "@letta-ai/letta-client";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { getResumeData } from "../../agent/check-approval";

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: "agent-test",
    message_ids: ["msg-last"],
    ...overrides,
  } as AgentState;
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
  test("includeMessageHistory=false still computes pending approvals without backfill (conversation path)", async () => {
    const conversationsRetrieve = mock(async () => ({
      in_context_message_ids: ["msg-last"],
    }));
    const conversationsList = mock(async () => ({
      getPaginatedItems: () => [],
    }));
    const agentsList = mock(async () => ({ items: [] }));
    const messagesRetrieve = mock(async () => [makeApprovalMessage()]);

    const client = {
      conversations: {
        retrieve: conversationsRetrieve,
        messages: { list: conversationsList },
      },
      agents: { messages: { list: agentsList } },
      messages: { retrieve: messagesRetrieve },
    } as unknown as Letta;

    const resume = await getResumeData(client, makeAgent(), "conv-abc", {
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
    const agentsList = mock(async () => ({ items: [] }));
    const messagesRetrieve = mock(async () => [makeApprovalMessage()]);

    const client = {
      conversations: {
        retrieve: conversationsRetrieve,
        messages: { list: conversationsList },
      },
      agents: { messages: { list: agentsList } },
      messages: { retrieve: messagesRetrieve },
    } as unknown as Letta;

    const resume = await getResumeData(
      client,
      makeAgent({ message_ids: ["msg-last"] }),
      "default",
      { includeMessageHistory: false },
    );

    expect(messagesRetrieve).toHaveBeenCalledTimes(1);
    expect(agentsList).toHaveBeenCalledTimes(0);
    expect(resume.pendingApprovals).toHaveLength(1);
    expect(resume.messageHistory).toEqual([]);
  });

  test("default behavior keeps backfill enabled when options are omitted", async () => {
    const conversationsRetrieve = mock(async () => ({
      in_context_message_ids: ["msg-last"],
    }));
    const conversationsList = mock(async () => ({
      getPaginatedItems: () => [
        makeUserMessage("msg-a"),
        makeUserMessage("msg-b"),
      ],
    }));
    const messagesRetrieve = mock(async () => [makeUserMessage()]);

    const client = {
      conversations: {
        retrieve: conversationsRetrieve,
        messages: { list: conversationsList },
      },
      messages: { retrieve: messagesRetrieve },
    } as unknown as Letta;

    const resume = await getResumeData(client, makeAgent(), "default");

    expect(messagesRetrieve).toHaveBeenCalledTimes(1);
    expect(conversationsList).toHaveBeenCalledTimes(1);
    expect(resume.pendingApprovals).toHaveLength(0);
    expect(resume.messageHistory.length).toBeGreaterThan(0);
  });
});
