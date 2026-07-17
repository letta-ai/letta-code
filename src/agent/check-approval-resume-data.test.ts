import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  Message,
  MessageType,
} from "@letta-ai/letta-client/resources/agents/messages";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import { __testSetBackend, type Backend } from "@/backend";

type ResumeAgentState = AgentState & {
  in_context_message_ids?: string[] | null;
};

function installBackend(overrides: Record<string, unknown>): void {
  const getConversationResumeTail = mock(
    async (
      agentId: string,
      conversationId: string,
      options: { limit: number; includeReturnMessageTypes?: string[] },
    ) => {
      if (conversationId && conversationId !== "default") {
        const conversation = await (
          overrides.retrieveConversation as (
            conversationId: string,
          ) => Promise<unknown>
        )?.(conversationId);
        const page = await (
          overrides.listConversationMessages as (
            conversationId: string,
            body: Record<string, unknown>,
          ) => Promise<{ getPaginatedItems: () => Message[] }>
        )?.(conversationId, {
          limit: options.limit,
          order: "desc",
          include_return_message_types: options.includeReturnMessageTypes,
        });
        return { conversation, messages: page?.getPaginatedItems() ?? [] };
      }

      const page = await (
        overrides.listAgentMessages as (
          agentId: string,
          body: Record<string, unknown>,
        ) => Promise<{ getPaginatedItems: () => Message[] }>
      )?.(agentId, {
        conversation_id: "default",
        limit: options.limit,
        order: "desc",
        include_return_message_types: options.includeReturnMessageTypes,
      });
      return { messages: page?.getPaginatedItems() ?? [] };
    },
  );

  __testSetBackend({
    getConversationResumeTail,
    ...overrides,
  } as unknown as Backend);
}

const DEFAULT_RESUME_MESSAGE_TYPES: MessageType[] = [
  "user_message",
  "assistant_message",
  "reasoning_message",
  "event_message",
  "summary_message",
  "approval_request_message",
  "tool_return_message",
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

function makeSummaryMessage(id = "msg-summary"): Message {
  return {
    id,
    date: new Date().toISOString(),
    message_type: "summary_message",
  } as Message;
}

function datedMessage(
  id: string,
  messageType: MessageType,
  date: string,
  extras: Record<string, unknown> = {},
): Message {
  return {
    id,
    date,
    message_type: messageType,
    ...extras,
  } as unknown as Message;
}

async function captureDebugOutput<T>(
  run: () => Promise<T>,
): Promise<{ output: string; result: T }> {
  const previousDebug = process.env.LETTA_DEBUG;
  const previousDebugFile = process.env.LETTA_DEBUG_FILE;
  const debugDir = mkdtempSync(join(tmpdir(), "letta-debug-"));
  const debugFile = join(debugDir, "debug.log");

  process.env.LETTA_DEBUG = "1";
  process.env.LETTA_DEBUG_FILE = debugFile;

  try {
    const result = await run();
    const output = existsSync(debugFile) ? readFileSync(debugFile, "utf8") : "";
    return { output, result };
  } finally {
    if (previousDebug === undefined) {
      delete process.env.LETTA_DEBUG;
    } else {
      process.env.LETTA_DEBUG = previousDebug;
    }

    if (previousDebugFile === undefined) {
      delete process.env.LETTA_DEBUG_FILE;
    } else {
      process.env.LETTA_DEBUG_FILE = previousDebugFile;
    }

    rmSync(debugDir, { recursive: true, force: true });
  }
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

    const resume = await getResumeDataFromBackend(makeAgent(), "conv-abc", {
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

    const resume = await getResumeDataFromBackend(
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

    const resume = await getResumeDataFromBackend(
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

  test("default conversation resume uses agent message_ids when in-context ids are absent", async () => {
    const agentsList = mock(async () => ({
      getPaginatedItems: () => [makeSummaryMessage("msg-summary-latest")],
    }));
    const messagesRetrieve = mock(async () => [
      makeApprovalMessage("msg-pending-approval"),
    ]);

    installBackend({
      listAgentMessages: agentsList,
      retrieveMessage: messagesRetrieve,
    });

    const resume = await getResumeDataFromBackend(
      makeAgent({
        message_ids: ["msg-pending-approval"],
      }),
      "default",
    );

    expect(messagesRetrieve).toHaveBeenCalledWith("msg-pending-approval");
    expect(messagesRetrieve).toHaveBeenCalledTimes(1);
    expect(agentsList).toHaveBeenCalledTimes(1);
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

    const resume = await getResumeDataFromBackend(
      makeAgent({ in_context_message_ids: [] }),
      "default",
      { includeMessageHistory: false },
    );

    expect(messagesRetrieve).toHaveBeenCalledTimes(0);
    expect(agentsList).toHaveBeenCalledTimes(1);
    expect(agentsList).toHaveBeenCalledWith("agent-test", {
      conversation_id: "default",
      limit: 1,
      order: "desc",
      include_return_message_types: DEFAULT_RESUME_MESSAGE_TYPES,
    });
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

    const resume = await getResumeDataFromBackend(
      makeAgent({ in_context_message_ids: ["msg-last"] }),
      "default",
    );

    expect(messagesRetrieve).toHaveBeenCalledTimes(1);
    expect(agentsList).toHaveBeenCalledTimes(1);
    expect(agentsList).toHaveBeenCalledWith("agent-test", {
      conversation_id: "default",
      limit: 50,
      order: "desc",
      include_return_message_types: DEFAULT_RESUME_MESSAGE_TYPES,
    });
    expect(resume.pendingApprovals).toHaveLength(0);
    expect(resume.messageHistory.length).toBeGreaterThan(0);
  });

  test("does not warn about missing assistant messages for an empty new conversation", async () => {
    const conversationsRetrieve = mock(async () => ({
      in_context_message_ids: [],
    }));
    const conversationsList = mock(async () => ({
      getPaginatedItems: () => [],
    }));

    installBackend({
      retrieveConversation: conversationsRetrieve,
      listConversationMessages: conversationsList,
    });

    const { output, result } = await captureDebugOutput(() =>
      getResumeDataFromBackend(makeAgent(), "conv-new"),
    );

    expect(result.pendingApprovals).toEqual([]);
    expect(result.messageHistory).toEqual([]);
    expect(output).not.toContain("Backfill scan found 0 assistant messages");
  });

  test("does not fail resume when stale in-context message is missing", async () => {
    const conversationsRetrieve = mock(async () => ({
      in_context_message_ids: ["ui-msg-missing"],
    }));
    const conversationsList = mock(async () => ({
      getPaginatedItems: () => [makeUserMessage("ui-msg-earlier")],
    }));
    const messagesRetrieve = mock(async () => {
      const error = new Error("Message ui-msg-missing not found") as Error & {
        status: number;
      };
      error.status = 404;
      throw error;
    });

    installBackend({
      retrieveConversation: conversationsRetrieve,
      listConversationMessages: conversationsList,
      retrieveMessage: messagesRetrieve,
    });

    const resume = await getResumeDataFromBackend(makeAgent(), "conv-stale");

    expect(messagesRetrieve).toHaveBeenCalledWith("ui-msg-missing");
    expect(resume.pendingApprovals).toEqual([]);
    expect(resume.pendingApproval).toBeNull();
    expect(resume.messageHistory.map((message) => message.id)).toEqual([
      "ui-msg-earlier",
    ]);
  });

  test("warns about missing assistant messages after a full backfill scan", async () => {
    const conversationsRetrieve = mock(async () => ({
      in_context_message_ids: ["msg-49"],
    }));
    const conversationsList = mock(async () => ({
      getPaginatedItems: () =>
        Array.from({ length: 50 }, (_, index) =>
          makeUserMessage(`msg-${index}`),
        ),
    }));

    installBackend({
      retrieveConversation: conversationsRetrieve,
      listConversationMessages: conversationsList,
    });

    const { output } = await captureDebugOutput(() =>
      getResumeDataFromBackend(makeAgent(), "conv-full"),
    );

    expect(output).toContain(
      "Backfill scan found 0 assistant messages in last 50 messages",
    );
  });

  test("uses resume tail for pending approval without retrieving last message when source variants are complete", async () => {
    const getConversationResumeTail = mock(async () => ({
      messages: [
        makeUserMessage("msg-user"),
        makeApprovalMessage("msg-live:tool:tool-1:request"),
      ],
    }));
    const messagesRetrieve = mock(async () => [
      makeApprovalMessage("msg-live:tool:tool-1:request"),
    ]);

    installBackend({
      getConversationResumeTail,
      retrieveMessage: messagesRetrieve,
    });

    const resume = await getResumeDataFromBackend(
      makeAgent({ in_context_message_ids: ["msg-live"] }),
      "default",
    );

    expect(getConversationResumeTail).toHaveBeenCalledTimes(1);
    expect(messagesRetrieve).toHaveBeenCalledTimes(0);
    expect(resume.pendingApprovals).toHaveLength(1);
    expect(resume.pendingApprovals[0]?.toolCallId).toBe("tool-1");
  });

  test("verifies pending approval when bounded tail may contain partial source variants", async () => {
    const getConversationResumeTail = mock(async () => ({
      messages: [makeApprovalMessage("msg-live:tool:tool-1:request")],
    }));
    const messagesRetrieve = mock(async () => [
      makeApprovalMessage("msg-live:tool:tool-1:request"),
      datedMessage(
        "msg-live:tool:tool-1:return",
        "tool_return_message",
        "2026-01-01T00:00:02.000Z",
        {
          tool_call_id: "tool-1",
          status: "success",
          tool_return: "ok",
        },
      ),
    ]);

    installBackend({
      getConversationResumeTail,
      retrieveMessage: messagesRetrieve,
    });

    const resume = await getResumeDataFromBackend(
      makeAgent({ in_context_message_ids: ["msg-live"] }),
      "default",
    );

    expect(getConversationResumeTail).toHaveBeenCalledTimes(1);
    expect(messagesRetrieve).toHaveBeenCalledWith("msg-live");
    expect(messagesRetrieve).toHaveBeenCalledTimes(1);
    expect(resume.pendingApprovals).toEqual([]);
  });

  test("explicit conversation backfill requests and preserves tool messages", async () => {
    const sameDate = "2026-01-01T00:00:02.000Z";
    const conversationsRetrieve = mock(async () => ({
      in_context_message_ids: ["provider-msg-2"],
      summary: "my-custom-conversation",
    }));
    const conversationsList = mock(async () => ({
      getPaginatedItems: () => [
        datedMessage("provider-msg-2:assistant", "assistant_message", sameDate),
        datedMessage(
          "provider-msg-2:tool:call-1:return",
          "tool_return_message",
          sameDate,
          {
            tool_call_id: "call-1",
            status: "success",
            tool_return: "ok",
          },
        ),
        datedMessage(
          "provider-msg-2:tool:call-1:request",
          "approval_request_message",
          sameDate,
          {
            tool_call: {
              tool_call_id: "call-1",
              name: "Read",
              arguments: '{"path":"src/index.ts"}',
            },
          },
        ),
        datedMessage(
          "provider-msg-1",
          "user_message",
          "2026-01-01T00:00:01.000Z",
        ),
      ],
    }));
    const messagesRetrieve = mock(async () => []);

    installBackend({
      retrieveConversation: conversationsRetrieve,
      listConversationMessages: conversationsList,
      retrieveMessage: messagesRetrieve,
    });

    const resume = await getResumeDataFromBackend(makeAgent(), "conv-abc");

    expect(conversationsList).toHaveBeenCalledWith("conv-abc", {
      limit: 50,
      order: "desc",
      include_return_message_types: DEFAULT_RESUME_MESSAGE_TYPES,
    });
    expect(
      resume.messageHistory.map((message) => message.message_type),
    ).toEqual([
      "user_message",
      "approval_request_message",
      "tool_return_message",
      "assistant_message",
    ]);
    expect(resume.conversationSummary).toBe("my-custom-conversation");
  });

  test("default conversation backfill orders equal-timestamp local tool messages before assistant text", async () => {
    const sameDate = "2026-01-01T00:00:02.000Z";
    const listedMessages = [
      datedMessage("provider-msg-2:assistant", "assistant_message", sameDate),
      datedMessage(
        "provider-msg-2:tool:call-1:return",
        "tool_return_message",
        sameDate,
        {
          tool_call_id: "call-1",
          status: "success",
          tool_return: "ok",
        },
      ),
      datedMessage(
        "provider-msg-2:approval:call-1:request",
        "approval_request_message",
        sameDate,
        {
          tool_call: {
            tool_call_id: "call-1",
            name: "ShellCommand",
            arguments: '{"command":"pwd"}',
          },
        },
      ),
      datedMessage(
        "provider-msg-1",
        "user_message",
        "2026-01-01T00:00:01.000Z",
      ),
    ];
    const agentsList = mock(async () => ({
      getPaginatedItems: () => listedMessages,
    }));
    const messagesRetrieve = mock(async () => []);

    installBackend({
      listAgentMessages: agentsList,
      retrieveMessage: messagesRetrieve,
    });

    const resume = await getResumeDataFromBackend(
      makeAgent({ in_context_message_ids: ["provider-msg-2"] }),
      "default",
    );

    expect(
      resume.messageHistory.map((message) => message.message_type),
    ).toEqual([
      "user_message",
      "approval_request_message",
      "tool_return_message",
      "assistant_message",
    ]);
  });

  test("completed local approval request variants are not treated as pending", async () => {
    const messagesRetrieve = mock(async () => [
      datedMessage(
        "provider-msg-2:tool:call-1:request",
        "approval_request_message",
        "2026-01-01T00:00:02.000Z",
        {
          tool_call: {
            tool_call_id: "call-1",
            name: "ShellCommand",
            arguments: '{"command":"pwd"}',
          },
        },
      ),
      datedMessage(
        "provider-msg-2:tool:call-1:return",
        "tool_return_message",
        "2026-01-01T00:00:02.000Z",
        {
          tool_call_id: "call-1",
          status: "success",
          tool_return: "ok",
        },
      ),
    ]);

    installBackend({
      retrieveMessage: messagesRetrieve,
    });

    const resume = await getResumeDataFromBackend(
      makeAgent({
        message_ids: ["provider-msg-2"],
        in_context_message_ids: ["provider-msg-2"],
      }),
      "default",
      { includeMessageHistory: false },
    );

    expect(messagesRetrieve).toHaveBeenCalledWith("provider-msg-2");
    expect(resume.pendingApprovals).toEqual([]);
    expect(resume.pendingApproval).toBeNull();
  });

  test("uses latest pending approval variant when message has many tool variants", async () => {
    const messagesRetrieve = mock(async () => [
      datedMessage(
        "ui-msg-122:tool:call-old:request",
        "approval_request_message",
        "2026-01-01T00:00:02.000Z",
        {
          tool_call: {
            tool_call_id: "call-old",
            name: "ShellCommand",
            arguments: '{"command":"echo old"}',
          },
        },
      ),
      datedMessage(
        "ui-msg-122:tool:call-old:return",
        "tool_return_message",
        "2026-01-01T00:00:02.000Z",
        {
          tool_call_id: "call-old",
          status: "success",
          tool_return: "ok",
        },
      ),
      datedMessage(
        "ui-msg-122:tool:call-latest:request",
        "approval_request_message",
        "2026-01-01T00:00:02.000Z",
        {
          tool_call: {
            tool_call_id: "call-latest",
            name: "ApplyPatch",
            arguments: '{"input":"*** Begin Patch"}',
          },
        },
      ),
    ]);

    installBackend({
      retrieveMessage: messagesRetrieve,
    });

    const resume = await getResumeDataFromBackend(
      makeAgent({
        message_ids: ["ui-msg-122"],
        in_context_message_ids: ["ui-msg-122"],
      }),
      "default",
      { includeMessageHistory: false },
    );

    expect(messagesRetrieve).toHaveBeenCalledWith("ui-msg-122");
    expect(resume.pendingApprovals).toHaveLength(1);
    expect(resume.pendingApprovals[0]?.toolCallId).toBe("call-latest");
    expect(resume.pendingApprovals[0]?.toolName).toBe("ApplyPatch");
    expect(resume.pendingApproval?.toolCallId).toBe("call-latest");
  });
});
