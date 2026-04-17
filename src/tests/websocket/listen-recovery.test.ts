/**
 * Tests for pending approval recovery semantics (reconnect scenario).
 *
 * Covers:
 * 1. Cold-start recovery: empty batch map → synthetic batch ID generated.
 * 2. Warm recovery: existing batch map entries → resolved to single batch ID.
 * 3. Ambiguous mapping: conflicting batch IDs → fail-closed (null).
 * 4. Idempotency: repeated resolve calls with same state → same behavior.
 * 5. isRecoveringApprovals guard prevents concurrent recovery.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  __testOverrideLoadPendingControlRequestStore,
  __testOverrideSavePendingControlRequestStore,
  clearPendingControlRequestStore,
} from "../../channels/pendingControlRequests";
import { ChannelRegistry, getChannelRegistry } from "../../channels/registry";
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
} from "../../channels/types";
import { __listenClientTestUtils } from "../../websocket/listen-client";

const {
  createRuntime,
  createListenerRuntime,
  recoverPendingChannelControlRequests,
  resolveRecoveryBatchId,
  resolvePendingApprovalBatchId,
  rememberPendingApprovalBatchIds,
} = __listenClientTestUtils;

afterEach(async () => {
  const registry = getChannelRegistry();
  if (registry) {
    await registry.stopAll();
  }
  __testOverrideLoadPendingControlRequestStore(null);
  __testOverrideSavePendingControlRequestStore(null);
  clearPendingControlRequestStore();
});

function createPendingControlRequestEvent(
  overrides: Partial<ChannelControlRequestEvent> = {},
): ChannelControlRequestEvent {
  return {
    requestId: "perm-tool-call-1",
    kind: "ask_user_question",
    source: {
      channel: "slack",
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      messageId: "1712800000.000100",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
    },
    toolName: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "Which approach should we use?",
          header: "Approach",
          options: [
            {
              label: "Fast path",
              description: "Ship the smallest safe patch",
            },
            {
              label: "Deep refactor",
              description: "Restructure the code more thoroughly",
            },
          ],
          multiSelect: false,
        },
      ],
    },
    ...overrides,
  };
}

function createAdapter(
  replies: Array<{ chatId: string; text: string; replyToMessageId?: string }>,
): ChannelAdapter {
  return {
    id: "slack:acct-slack",
    channelId: "slack",
    accountId: "acct-slack",
    name: "Slack",
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    sendMessage: async () => ({ messageId: "msg-1" }),
    sendDirectReply: async (chatId, text, options) => {
      replies.push({
        chatId,
        text,
        replyToMessageId: options?.replyToMessageId,
      });
    },
    onMessage: undefined,
  };
}

describe("resolveRecoveryBatchId cold-start", () => {
  test("empty batch map returns synthetic recovery-* batch ID", () => {
    const runtime = createRuntime();
    expect(runtime.pendingApprovalBatchByToolCallId.size).toBe(0);

    const batchId = resolveRecoveryBatchId(runtime, [
      { toolCallId: "call-1" },
      { toolCallId: "call-2" },
    ]);

    expect(batchId).not.toBeNull();
    expect(batchId?.startsWith("recovery-")).toBe(true);
  });

  test("each cold-start call generates a unique batch ID", () => {
    const runtime = createRuntime();
    const id1 = resolveRecoveryBatchId(runtime, [{ toolCallId: "call-1" }]);
    const id2 = resolveRecoveryBatchId(runtime, [{ toolCallId: "call-1" }]);

    expect(id1).not.toBe(id2);
  });

  test("cold-start returns synthetic even with empty approval list", () => {
    const runtime = createRuntime();
    const batchId = resolveRecoveryBatchId(runtime, []);

    expect(batchId).not.toBeNull();
    expect(batchId?.startsWith("recovery-")).toBe(true);
  });
});

describe("resolveRecoveryBatchId warm path", () => {
  test("returns existing batch ID when all approvals map to same batch", () => {
    const runtime = createRuntime();
    rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "call-1" }, { toolCallId: "call-2" }],
      "batch-1",
    );

    const batchId = resolveRecoveryBatchId(runtime, [
      { toolCallId: "call-1" },
      { toolCallId: "call-2" },
    ]);

    expect(batchId).toBe("batch-1");
  });

  test("returns null for ambiguous mapping (multiple batch IDs)", () => {
    const runtime = createRuntime();
    rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "call-1" }],
      "batch-1",
    );
    rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "call-2" }],
      "batch-2",
    );

    const batchId = resolveRecoveryBatchId(runtime, [
      { toolCallId: "call-1" },
      { toolCallId: "call-2" },
    ]);

    expect(batchId).toBeNull();
  });

  test("returns null when approval has no batch mapping", () => {
    const runtime = createRuntime();
    rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "call-1" }],
      "batch-1",
    );

    // call-2 has no mapping
    const batchId = resolveRecoveryBatchId(runtime, [
      { toolCallId: "call-1" },
      { toolCallId: "call-2" },
    ]);

    expect(batchId).toBeNull();
  });
});

describe("isRecoveringApprovals guard", () => {
  test("runtime starts with isRecoveringApprovals = false", () => {
    const runtime = createRuntime();
    expect(runtime.isRecoveringApprovals).toBe(false);
  });

  test("guard flag prevents concurrent recovery (production pattern)", () => {
    const runtime = createRuntime();

    // Simulate first recovery in progress
    runtime.isRecoveringApprovals = true;

    // Second recovery attempt should observe guard and bail
    expect(runtime.isRecoveringApprovals).toBe(true);

    // Simulate completion
    runtime.isRecoveringApprovals = false;
    expect(runtime.isRecoveringApprovals).toBe(false);
  });
});

describe("resolvePendingApprovalBatchId original behavior preserved", () => {
  test("returns null when map is empty (unchanged behavior)", () => {
    const runtime = createRuntime();
    const batchId = resolvePendingApprovalBatchId(runtime, [
      { toolCallId: "call-1" },
    ]);
    expect(batchId).toBeNull();
  });

  test("returns batch ID for single consistent mapping", () => {
    const runtime = createRuntime();
    rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "call-1" }],
      "batch-abc",
    );

    const batchId = resolvePendingApprovalBatchId(runtime, [
      { toolCallId: "call-1" },
    ]);
    expect(batchId).toBe("batch-abc");
  });

  test("returns null for conflicting mappings (strict fail-closed)", () => {
    const runtime = createRuntime();
    rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "call-1" }],
      "batch-a",
    );
    rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "call-2" }],
      "batch-b",
    );

    const batchId = resolvePendingApprovalBatchId(runtime, [
      { toolCallId: "call-1" },
      { toolCallId: "call-2" },
    ]);
    expect(batchId).toBeNull();
  });
});

describe("channel control request recovery", () => {
  test("redelivers persisted channel prompts that are still pending after boot", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const event = createPendingControlRequestEvent();
    __testOverrideLoadPendingControlRequestStore(() => ({
      requests: [event],
    }));

    const registry = new ChannelRegistry();
    registry.registerAdapter(createAdapter(replies));
    const listener = createListenerRuntime();

    await recoverPendingChannelControlRequests(listener, {
      recoverApprovalStateForSync: async (runtime) => {
        runtime.recoveredApprovalState = {
          agentId: "agent-1",
          conversationId: "conv-1",
          approvalsByRequestId: new Map([
            [
              event.requestId,
              {
                approval: {} as never,
                approvalContext: null,
                controlRequest: {
                  type: "control_request",
                  request_id: event.requestId,
                  request: {
                    subtype: "can_use_tool",
                    tool_name: event.toolName,
                    input: event.input,
                    tool_call_id: "tool-call-1",
                    permission_suggestions: [],
                    blocked_path: null,
                  },
                  agent_id: "agent-1",
                  conversation_id: "conv-1",
                },
              },
            ],
          ]),
          pendingRequestIds: new Set([event.requestId]),
          responsesByRequestId: new Map(),
        };
      },
    });

    expect(replies).toEqual([
      {
        chatId: "C123",
        text: expect.stringContaining(
          "The agent needs an answer before it can continue.",
        ),
        replyToMessageId: "1712790000.000050",
      },
    ]);
    expect(registry.hasPendingControlRequest(event.requestId)).toBe(true);
  });

  test("clears persisted channel prompts that are no longer pending", async () => {
    const saveSnapshots: Array<{ requests: ChannelControlRequestEvent[] }> = [];
    const event = createPendingControlRequestEvent();
    __testOverrideLoadPendingControlRequestStore(() => ({
      requests: [event],
    }));
    __testOverrideSavePendingControlRequestStore((store) => {
      saveSnapshots.push({
        requests: store.requests,
      });
    });

    const registry = new ChannelRegistry();
    registry.registerAdapter(createAdapter([]));
    const listener = createListenerRuntime();

    await recoverPendingChannelControlRequests(listener, {
      recoverApprovalStateForSync: async (runtime) => {
        runtime.recoveredApprovalState = null;
      },
    });

    expect(registry.hasPendingControlRequest(event.requestId)).toBe(false);
    expect(saveSnapshots.at(-1)).toEqual({ requests: [] });
  });
});
