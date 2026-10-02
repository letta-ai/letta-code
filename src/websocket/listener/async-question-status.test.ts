import { describe, expect, test } from "bun:test";
import { APIError } from "@letta-ai/letta-client/core/error";
import type { ApprovalResult } from "@/agent/approval-execution";
import {
  clearPendingAsyncQuestionsFromMessage,
  extractIncomingMessageText,
  registerPendingAsyncQuestions,
} from "./async-question-status";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { buildDeviceStatus } from "./protocol-outbound";
import { recoverPendingAsyncQuestionsForSync } from "./recovery-sync";
import { evictConversationRuntimeIfIdle } from "./runtime";
import type { ConversationRuntime } from "./types";

function createScopedRuntime(): ConversationRuntime {
  return getOrCreateScopedRuntime(createRuntime(), "agent-1", "conv-1");
}

const questionReceipt = {
  type: "ask_user_question",
  version: 2,
  toolCallId: "call-ask-1",
  questions: [
    {
      question: "Proceed?",
      header: "Plan",
      options: [
        { label: "Yes", description: "Go ahead" },
        { label: "No", description: "Stop" },
      ],
    },
  ],
} as const;

function receiptResult(
  toolCallId: string,
  extra: Record<string, unknown> = {},
): ApprovalResult {
  return {
    type: "tool" as const,
    tool_call_id: toolCallId,
    tool_return: JSON.stringify({
      ...questionReceipt,
      toolCallId,
      message: "Questions posted.",
    }),
    status: "success" as const,
    ...extra,
  };
}

describe("registerPendingAsyncQuestions", () => {
  test("registers successful AskUserQuestionAsync receipts", () => {
    const runtime = createScopedRuntime();
    registerPendingAsyncQuestions(
      runtime,
      [{ approval: { toolCallId: "call-ask-1", toolName: "AskUserQuestion" } }],
      [receiptResult("call-ask-1")],
    );
    expect([...runtime.pendingAsyncQuestionToolCallIds]).toEqual([
      "call-ask-1",
    ]);
  });

  test("ignores other tools, errors, and mismatched receipts", () => {
    const runtime = createScopedRuntime();
    registerPendingAsyncQuestions(runtime, [], []);
    registerPendingAsyncQuestions(
      runtime,
      [{ approval: { toolCallId: "call-bash-1", toolName: "Bash" } }],
      [receiptResult("call-bash-1")],
    );
    registerPendingAsyncQuestions(
      runtime,
      [{ approval: { toolCallId: "call-err", toolName: "AskUserQuestion" } }],
      [{ ...receiptResult("call-err"), status: "error" }],
    );
    registerPendingAsyncQuestions(
      runtime,
      [{ approval: { toolCallId: "call-a", toolName: "AskUserQuestion" } }],
      [receiptResult("call-b")],
    );
    expect(runtime.pendingAsyncQuestionToolCallIds.size).toBe(0);
  });
});

describe("clearPendingAsyncQuestionsFromMessage", () => {
  test("clears answered and dismissed questions from user text", () => {
    const runtime = createScopedRuntime();
    runtime.pendingAsyncQuestionToolCallIds.add("call-ask-1");
    runtime.pendingAsyncQuestionToolCallIds.add("call-ask-2");
    const notif = (toolCallId: string, response: Record<string, unknown>) =>
      `<task-notification>\n<task-id>${toolCallId}</task-id>\n<summary>User responded to your questions.</summary>\n<ask-user-question-response>${JSON.stringify(
        {
          type: "ask_user_question_response",
          version: 2,
          toolCallId,
          questions: questionReceipt.questions,
          ...response,
        },
      )}</ask-user-question-response>\n</task-notification>`;
    const answered = { status: "answered", answers: { "Proceed?": "Yes" } };
    clearPendingAsyncQuestionsFromMessage(runtime, [
      { content: notif("call-ask-1", answered) },
      { content: notif("call-ask-2", { status: "dismissed" }) },
    ]);
    expect(runtime.pendingAsyncQuestionToolCallIds.size).toBe(0);
  });

  test("skips ApprovalCreate entries and non-matching text", () => {
    const runtime = createScopedRuntime();
    runtime.pendingAsyncQuestionToolCallIds.add("call-ask-1");
    clearPendingAsyncQuestionsFromMessage(runtime, [
      { approvals: [] },
      { content: "just a normal message" },
    ]);
    expect(runtime.pendingAsyncQuestionToolCallIds.size).toBe(1);
  });

  test("extracts text from multimodal parts", () => {
    expect(
      extractIncomingMessageText([
        {
          content: [
            { type: "text", text: "hello" },
            { type: "image_url", image_url: { url: "x" } },
          ],
        },
      ]),
    ).toBe("hello");
  });
});

describe("eviction and device status", () => {
  test("pending questions block idle eviction", () => {
    const runtime = createScopedRuntime();
    expect(evictConversationRuntimeIfIdle(runtime)).toBe(true);
    const runtime2 = createScopedRuntime();
    runtime2.pendingAsyncQuestionToolCallIds.add("call-ask-1");
    expect(evictConversationRuntimeIfIdle(runtime2)).toBe(false);
  });

  test("buildDeviceStatus relays pending async questions", () => {
    const runtime = createScopedRuntime();
    runtime.pendingAsyncQuestionToolCallIds.add("call-ask-1");
    const status = buildDeviceStatus(runtime, {
      agent_id: "agent-1",
      conversation_id: "conv-1",
    });
    expect(status.pending_async_questions).toEqual(["call-ask-1"]);
  });
});

describe("recoverPendingAsyncQuestionsForSync", () => {
  const scope = { agent_id: "agent-1", conversation_id: "conv-1" };

  function resumeDataWith(messages: unknown[], inContextIds?: string[]) {
    return {
      pendingApproval: null,
      pendingApprovals: [],
      messageHistory: messages,
      conversation: inContextIds
        ? { in_context_message_ids: inContextIds }
        : undefined,
    };
  }

  test("clears answered questions and adds open in-context receipts", async () => {
    const runtime = createScopedRuntime();
    runtime.pendingAsyncQuestionToolCallIds.add("call-answered");
    const deps = {
      getBackend: (() => ({
        retrieveAgent: async () => ({ id: "agent-1" }),
      })) as never,
      getResumeDataFromBackend: (async () =>
        resumeDataWith(
          [
            {
              id: "msg-return",
              message_type: "tool_return_message",
              status: "success",
              tool_call_id: "call-open",
              tool_return: JSON.stringify({
                ...questionReceipt,
                toolCallId: "call-open",
              }),
            },
            {
              id: "msg-user",
              message_type: "user_message",
              content: `<task-notification>\n<task-id>call-answered</task-id>\n<summary>User answered your questions.</summary>\n<ask-user-question-response>${JSON.stringify(
                {
                  type: "ask_user_question_response",
                  version: 2,
                  toolCallId: "call-answered",
                  questions: questionReceipt.questions,
                  status: "dismissed",
                },
              )}</ask-user-question-response>\n</task-notification>`,
            },
          ],
          ["msg-return", "msg-user"],
        )) as never,
    };
    await recoverPendingAsyncQuestionsForSync(runtime, scope, deps);
    expect([...runtime.pendingAsyncQuestionToolCallIds]).toEqual(["call-open"]);
  });

  test("ignores receipts evicted from context", async () => {
    const runtime = createScopedRuntime();
    const deps = {
      getBackend: (() => ({
        retrieveAgent: async () => ({ id: "agent-1" }),
      })) as never,
      getResumeDataFromBackend: (async () =>
        resumeDataWith(
          [
            {
              id: "msg-return",
              message_type: "tool_return_message",
              status: "success",
              tool_call_id: "call-open",
              tool_return: JSON.stringify({
                ...questionReceipt,
                toolCallId: "call-open",
              }),
            },
          ],
          ["msg-user"],
        )) as never,
    };
    await recoverPendingAsyncQuestionsForSync(runtime, scope, deps);
    expect(runtime.pendingAsyncQuestionToolCallIds.size).toBe(0);
  });

  test("clears the set when the agent is gone", async () => {
    const runtime = createScopedRuntime();
    runtime.pendingAsyncQuestionToolCallIds.add("call-ask-1");
    const deps = {
      getBackend: (() => ({
        retrieveAgent: async () => {
          throw new APIError(
            404,
            { message: "Not found" },
            "Not found",
            new Headers(),
          );
        },
      })) as never,
    };
    await recoverPendingAsyncQuestionsForSync(runtime, scope, deps);
    expect(runtime.pendingAsyncQuestionToolCallIds.size).toBe(0);
  });

  test("returns without agent scope", async () => {
    const runtime = createScopedRuntime();
    runtime.pendingAsyncQuestionToolCallIds.add("call-ask-1");
    await recoverPendingAsyncQuestionsForSync(runtime, {
      agent_id: null,
      conversation_id: "conv-1",
    });
    expect(runtime.pendingAsyncQuestionToolCallIds.size).toBe(1);
  });
});
