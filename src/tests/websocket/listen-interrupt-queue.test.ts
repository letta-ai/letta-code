/**
 * Tests for the interrupt queue mechanism (LET-7796).
 *
 * Structure:
 * 1. Structural tests — field initialization, teardown, epoch guards
 * 2. Behavior-path tests — exercises populateInterruptQueue + consumeInterruptQueue
 *    through the same state sequences as the production cancel/resume flow:
 *    - Cancel during tool execution (Path A) → next turn consumes queued results
 *    - Cancel during approval wait (Path B) → next turn consumes synthesized denials
 *    - Post-cancel next turn → no repeated error loop (queue consumed once)
 *    - Stale-ID guard: clearing IDs after send prevents stale Path-B denials
 */
import { describe, expect, test } from "bun:test";
import WebSocket from "ws";
import type { ApprovalResult } from "../../agent/approval-execution";
import { LIMITS } from "../../tools/impl/truncation";
import {
  __listenClientTestUtils,
  rejectPendingApprovalResolvers,
} from "../../websocket/listen-client";

const {
  createRuntime,
  createListenerRuntime,
  getOrCreateConversationRuntime,
  stopRuntime,
  rememberPendingApprovalBatchIds,
  populateInterruptQueue,
  consumeInterruptQueue,
  extractInterruptToolReturns,
  emitInterruptToolReturnMessage,
  getInterruptApprovalsForEmission,
} = __listenClientTestUtils;

class MockSocket {
  readyState: number;
  closeCalls = 0;
  removeAllListenersCalls = 0;
  sentPayloads: string[] = [];

  constructor(readyState: number = WebSocket.OPEN) {
    this.readyState = readyState;
  }

  send(data: string): void {
    this.sentPayloads.push(data);
  }

  close(): void {
    this.closeCalls += 1;
  }

  removeAllListeners(): this {
    this.removeAllListenersCalls += 1;
    return this;
  }
}

// ---------------------------------------------------------------------------
// 1. Structural tests
// ---------------------------------------------------------------------------

describe("ListenerRuntime interrupt queue fields", () => {
  test("createRuntime initializes interrupt queue fields to safe defaults", () => {
    const runtime = createRuntime();
    expect(runtime.pendingInterruptedResults).toBeNull();
    expect(runtime.pendingInterruptedContext).toBeNull();
    expect(runtime.pendingInterruptedToolCallIds).toBeNull();
    expect(runtime.activeExecutingToolCallIds).toEqual([]);
    expect(runtime.continuationEpoch).toBe(0);
  });
});

describe("stopRuntime teardown", () => {
  test("clears pendingInterruptedResults, context, ids, and batch map", () => {
    const runtime = createRuntime();
    runtime.socket = new MockSocket(WebSocket.OPEN) as unknown as WebSocket;

    runtime.pendingInterruptedResults = [
      {
        type: "approval",
        tool_call_id: "call-1",
        approve: false,
        reason: "interrupted",
      },
    ];
    runtime.pendingInterruptedContext = {
      agentId: "agent-1",
      conversationId: "conv-1",
      continuationEpoch: 0,
    };
    runtime.pendingInterruptedToolCallIds = ["call-1"];
    runtime.activeExecutingToolCallIds = ["call-1"];
    runtime.pendingApprovalBatchByToolCallId.set("call-1", "batch-1");

    stopRuntime(runtime, true);

    expect(runtime.pendingInterruptedResults).toBeNull();
    expect(runtime.pendingInterruptedContext).toBeNull();
    expect(runtime.pendingInterruptedToolCallIds).toBeNull();
    expect(runtime.activeExecutingToolCallIds).toEqual([]);
    expect(runtime.pendingApprovalBatchByToolCallId.size).toBe(0);
  });

  test("increments continuationEpoch on each stop", () => {
    const listener = createListenerRuntime();
    listener.socket = new MockSocket(WebSocket.OPEN) as unknown as WebSocket;

    const runtimeA = getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-1",
    );
    const runtimeB = getOrCreateConversationRuntime(
      listener,
      "agent-2",
      "conv-2",
    );

    expect(runtimeA.continuationEpoch).toBe(0);
    expect(runtimeB.continuationEpoch).toBe(0);

    stopRuntime(listener, true);

    expect(runtimeA.continuationEpoch).toBe(1);
    expect(runtimeB.continuationEpoch).toBe(1);
    expect(listener.conversationRuntimes.size).toBe(0);
  });
});

describe("pendingApprovalBatchByToolCallId survives rejectPendingApprovalResolvers", () => {
  test("batch map preserved after resolver rejection (used for Path B IDs)", () => {
    const runtime = createRuntime();
    runtime.pendingApprovalBatchByToolCallId.set("call-1", "batch-1");
    runtime.pendingApprovalResolvers.set("perm-1", {
      resolve: () => {},
      reject: () => {},
    });

    rejectPendingApprovalResolvers(runtime, "cancelled");

    expect(runtime.pendingApprovalResolvers.size).toBe(0);
    expect(runtime.pendingApprovalBatchByToolCallId.size).toBe(1);
  });
});

describe("extractInterruptToolReturns", () => {
  test("maps completed tool execution results into tool_return payloads", () => {
    const results: ApprovalResult[] = [
      {
        type: "tool",
        tool_call_id: "call-ok",
        status: "success",
        tool_return: "704",
      } as ApprovalResult,
      {
        type: "tool",
        tool_call_id: "call-err",
        status: "error",
        tool_return: "User interrupted the stream",
        stderr: ["interrupted"],
      } as ApprovalResult,
    ];

    const mapped = extractInterruptToolReturns(results);
    expect(mapped).toEqual([
      {
        tool_call_id: "call-ok",
        status: "success",
        tool_return: "704",
      },
      {
        tool_call_id: "call-err",
        status: "error",
        tool_return: "User interrupted the stream",
        stderr: ["interrupted"],
      },
    ]);
  });

  test("maps synthesized approval denials into terminal error tool returns", () => {
    const results: ApprovalResult[] = [
      {
        type: "approval",
        tool_call_id: "call-denied",
        approve: false,
        reason: "User interrupted the stream",
      } as ApprovalResult,
    ];

    const mapped = extractInterruptToolReturns(results);
    expect(mapped).toEqual([
      {
        tool_call_id: "call-denied",
        status: "error",
        tool_return: "User interrupted the stream",
      },
    ]);
  });

  test("converts multimodal tool_return content into displayable text", () => {
    const results: ApprovalResult[] = [
      {
        type: "tool",
        tool_call_id: "call-multimodal",
        status: "error",
        tool_return: [
          { type: "text", text: "Interrupted by user" },
          { type: "image", image_url: "https://example.com/image.png" },
        ],
      } as ApprovalResult,
    ];

    const mapped = extractInterruptToolReturns(results);
    expect(mapped).toEqual([
      {
        tool_call_id: "call-multimodal",
        status: "error",
        tool_return: "Interrupted by user",
      },
    ]);
  });

  test("emitInterruptToolReturnMessage emits deterministic per-tool terminal messages", () => {
    const runtime = createRuntime();
    const socket = new MockSocket(WebSocket.OPEN) as unknown as WebSocket;
    runtime.activeAgentId = "agent-1";
    runtime.activeConversationId = "default";
    const approvals: ApprovalResult[] = [
      {
        type: "tool",
        tool_call_id: "call-a",
        status: "success",
        tool_return: "704",
      } as ApprovalResult,
      {
        type: "approval",
        tool_call_id: "call-b",
        approve: false,
        reason: "User interrupted the stream",
      } as ApprovalResult,
    ];

    emitInterruptToolReturnMessage(socket, runtime, approvals, "run-1");

    const parsed = (socket as unknown as MockSocket).sentPayloads.map((raw) =>
      JSON.parse(raw),
    );
    const toolReturnFrames = parsed.filter(
      (payload) =>
        payload.type === "stream_delta" &&
        payload.delta?.message_type === "tool_return_message",
    );

    expect(toolReturnFrames).toHaveLength(2);
    expect(toolReturnFrames[0]).toMatchObject({
      delta: {
        run_id: "run-1",
        tool_returns: [
          { tool_call_id: "call-a", status: "success", tool_return: "704" },
        ],
      },
    });
    expect(toolReturnFrames[1]).toMatchObject({
      delta: {
        run_id: "run-1",
        tool_returns: [
          {
            tool_call_id: "call-b",
            status: "error",
            tool_return: "User interrupted the stream",
          },
        ],
      },
    });
    expect(toolReturnFrames[0].delta).toMatchObject({
      tool_returns: [
        { tool_call_id: "call-a", status: "success", tool_return: "704" },
      ],
    });
    expect(toolReturnFrames[0].delta.tool_call_id).toBe("call-a");
    expect(toolReturnFrames[0].delta.status).toBe("success");
    expect(toolReturnFrames[0].delta.tool_return).toBe("704");
    expect(toolReturnFrames[1].delta.tool_call_id).toBe("call-b");
    expect(toolReturnFrames[1].delta.status).toBe("error");
    expect(toolReturnFrames[1].delta.tool_return).toBe(
      "User interrupted the stream",
    );
  });

  test("emitInterruptToolReturnMessage truncates oversized tool returns and drops oversized stdout metadata", () => {
    const runtime = createRuntime();
    const socket = new MockSocket(WebSocket.OPEN) as unknown as WebSocket;
    runtime.activeAgentId = "agent-1";
    runtime.activeConversationId = "default";

    const hugeOutput = "x".repeat(LIMITS.BASH_OUTPUT_CHARS + 500);
    const approvals: ApprovalResult[] = [
      {
        type: "tool",
        tool_call_id: "call-huge",
        status: "success",
        tool_return: hugeOutput,
        stdout: [hugeOutput],
      } as ApprovalResult,
    ];

    emitInterruptToolReturnMessage(socket, runtime, approvals, "run-1");

    const parsed = (socket as unknown as MockSocket).sentPayloads.map((raw) =>
      JSON.parse(raw),
    );
    const toolReturnFrame = parsed.find(
      (payload) =>
        payload.type === "stream_delta" &&
        payload.delta?.message_type === "tool_return_message",
    );

    expect(toolReturnFrame).toBeDefined();
    expect(toolReturnFrame.delta.tool_return).toContain("[Output truncated:");
    expect(toolReturnFrame.delta.tool_return.length).toBeLessThan(
      hugeOutput.length,
    );
    expect(toolReturnFrame.delta.tool_returns[0].tool_return).toContain(
      "[Output truncated:",
    );
    expect("stdout" in toolReturnFrame.delta.tool_returns[0]).toBe(false);
  });
});

describe("getInterruptApprovalsForEmission", () => {
  test("prefers lastExecutionResults when available", () => {
    const runtime = createRuntime();
    runtime.pendingInterruptedResults = [
      {
        type: "approval",
        tool_call_id: "call-old",
        approve: false,
      },
    ];
    runtime.pendingInterruptedContext = {
      agentId: "agent-1",
      conversationId: "conv-1",
      continuationEpoch: runtime.continuationEpoch,
    };

    const result = getInterruptApprovalsForEmission(runtime, {
      lastExecutionResults: [
        {
          type: "approval",
          tool_call_id: "call-new",
          approve: true,
        },
      ],
      agentId: "agent-1",
      conversationId: "conv-1",
    });
    expect(result?.[0]).toMatchObject({ tool_call_id: "call-new" });
  });

  test("falls back to pendingInterruptedResults only when context matches", () => {
    const runtime = createRuntime();
    runtime.pendingInterruptedResults = [
      {
        type: "approval",
        tool_call_id: "call-pending",
        approve: false,
      },
    ];
    runtime.pendingInterruptedContext = {
      agentId: "agent-1",
      conversationId: "conv-1",
      continuationEpoch: runtime.continuationEpoch,
    };

    const matching = getInterruptApprovalsForEmission(runtime, {
      lastExecutionResults: null,
      agentId: "agent-1",
      conversationId: "conv-1",
    });
    expect(matching?.[0]).toMatchObject({ tool_call_id: "call-pending" });

    const mismatched = getInterruptApprovalsForEmission(runtime, {
      lastExecutionResults: null,
      agentId: "agent-2",
      conversationId: "conv-1",
    });
    expect(mismatched).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Behavior-path tests using extracted helpers
// ---------------------------------------------------------------------------

describe("Path A: cancel during tool execution → next turn consumes actual results", () => {
  test("full sequence: populate with execution results → consume on next turn", () => {
    const runtime = createRuntime();
    const agentId = "agent-abc";
    const conversationId = "conv-xyz";

    // Simulate: executeApprovalBatch completed, results captured
    const executionResults: ApprovalResult[] = [
      { type: "approval", tool_call_id: "call-1", approve: true },
      {
        tool_call_id: "call-2",
        status: "success",
        tool_return: "file written",
      } as unknown as ApprovalResult,
    ];

    // Cancel fires: populateInterruptQueue (Path A — has execution results)
    const populated = populateInterruptQueue(runtime, {
      lastExecutionResults: executionResults,
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: ["call-1", "call-2"],
      agentId,
      conversationId,
    });

    expect(populated).toBe(true);
    expect(runtime.pendingInterruptedResults).toEqual(executionResults);
    expect(runtime.pendingInterruptedContext).toMatchObject({
      agentId,
      conversationId,
      continuationEpoch: 0,
    });

    // Next user message arrives: consumeInterruptQueue
    const consumed = consumeInterruptQueue(runtime, agentId, conversationId);

    expect(consumed).not.toBeNull();
    expect(consumed?.approvalMessage.type).toBe("approval");
    expect(consumed?.approvalMessage.approvals).toEqual(executionResults);
    expect(consumed?.approvalMessage.approvals).toHaveLength(2);
    expect(consumed?.interruptedToolCallIds).toEqual([]);

    // Queue is atomically cleared after consumption
    expect(runtime.pendingInterruptedResults).toBeNull();
    expect(runtime.pendingInterruptedContext).toBeNull();
  });

  test("Path A takes priority over Path B even when both sources available", () => {
    const runtime = createRuntime();

    // Both execution results AND batch map IDs exist
    const executionResults: ApprovalResult[] = [
      { type: "approval", tool_call_id: "call-1", approve: true },
    ];
    runtime.pendingApprovalBatchByToolCallId.set("call-1", "batch-1");

    const populated = populateInterruptQueue(runtime, {
      lastExecutionResults: executionResults,
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: ["call-1"],
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    expect(populated).toBe(true);
    // Should contain the execution results (Path A), not synthesized denials (Path B)
    expect(runtime.pendingInterruptedResults?.[0]).toMatchObject({
      approve: true, // Path A preserves actual approval state
    });
  });

  test("normalizes interrupted tool results to error via structured tool_call_id", () => {
    const runtime = createRuntime();
    const executionResults: ApprovalResult[] = [
      {
        type: "tool",
        tool_call_id: "call-1",
        status: "success",
        tool_return: "result text does not matter when ID is interrupted",
      } as unknown as ApprovalResult,
    ];

    const populated = populateInterruptQueue(runtime, {
      lastExecutionResults: executionResults,
      lastExecutingToolCallIds: ["call-1"],
      lastNeedsUserInputToolCallIds: [],
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    expect(populated).toBe(true);
    expect(runtime.pendingInterruptedResults?.[0]).toMatchObject({
      type: "tool",
      tool_call_id: "call-1",
      status: "error",
    });
    expect(runtime.pendingInterruptedToolCallIds).toEqual(["call-1"]);
  });

  test("keeps legacy text fallback for interrupted tool return normalization", () => {
    const runtime = createRuntime();
    const executionResults: ApprovalResult[] = [
      {
        type: "tool",
        tool_call_id: "call-legacy",
        status: "success",
        tool_return: [{ type: "text", text: "Interrupted by user" }],
      } as unknown as ApprovalResult,
    ];

    const populated = populateInterruptQueue(runtime, {
      lastExecutionResults: executionResults,
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: [],
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    expect(populated).toBe(true);
    expect(runtime.pendingInterruptedResults?.[0]).toMatchObject({
      type: "tool",
      tool_call_id: "call-legacy",
      status: "error",
    });
  });
});

describe("Path B: cancel during approval wait → next turn consumes synthesized denials", () => {
  test("prefers synthesized tool-error results when execution was already in-flight", () => {
    const runtime = createRuntime();

    const populated = populateInterruptQueue(runtime, {
      lastExecutionResults: null,
      lastExecutingToolCallIds: ["call-running-1"],
      lastNeedsUserInputToolCallIds: ["call-running-1"],
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    expect(populated).toBe(true);
    expect(runtime.pendingInterruptedResults).toEqual([
      {
        type: "tool",
        tool_call_id: "call-running-1",
        tool_return: "Interrupted by user",
        status: "error",
      },
    ]);
    expect(runtime.pendingInterruptedToolCallIds).toEqual(["call-running-1"]);
  });

  test("full sequence: populate from batch map IDs → consume synthesized denials", () => {
    const runtime = createRuntime();
    const agentId = "agent-abc";
    const conversationId = "conv-xyz";

    // Simulate: approvals classified, batch IDs remembered, waiting for user input
    rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "call-1" }, { toolCallId: "call-2" }],
      "batch-42",
    );

    // Cancel fires during approval wait: no execution results
    const populated = populateInterruptQueue(runtime, {
      lastExecutionResults: null,
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: [],
      agentId,
      conversationId,
    });

    expect(populated).toBe(true);
    expect(runtime.pendingInterruptedResults).toHaveLength(2);

    // Verify synthesized denials
    const pendingResults = runtime.pendingInterruptedResults ?? [];
    for (const result of pendingResults) {
      expect(result).toMatchObject({
        type: "approval",
        approve: false,
        reason: "User interrupted the stream",
      });
    }
    const ids = runtime.pendingInterruptedResults?.map(
      (r) => "tool_call_id" in r && r.tool_call_id,
    );
    expect(ids).toContain("call-1");
    expect(ids).toContain("call-2");

    // Next user message: consume
    const consumed = consumeInterruptQueue(runtime, agentId, conversationId);
    expect(consumed).not.toBeNull();
    expect(consumed?.approvalMessage.approvals).toHaveLength(2);

    // Queue cleared
    expect(runtime.pendingInterruptedResults).toBeNull();
  });

  test("fallback to lastNeedsUserInputToolCallIds when batch map empty", () => {
    const runtime = createRuntime();

    // No batch map entries, but we have the snapshot IDs
    const populated = populateInterruptQueue(runtime, {
      lastExecutionResults: null,
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: ["call-a", "call-b"],
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    expect(populated).toBe(true);
    expect(runtime.pendingInterruptedResults).toHaveLength(2);
    const ids = runtime.pendingInterruptedResults?.map(
      (r) => "tool_call_id" in r && r.tool_call_id,
    );
    expect(ids).toEqual(["call-a", "call-b"]);
  });

  test("returns false when both ID sources empty (no-op edge case)", () => {
    const runtime = createRuntime();

    const populated = populateInterruptQueue(runtime, {
      lastExecutionResults: null,
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: [],
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    expect(populated).toBe(false);
    expect(runtime.pendingInterruptedResults).toBeNull();
  });
});

describe("post-cancel next turn: queue consumed exactly once (no error loop)", () => {
  test("second consumeInterruptQueue returns null after first consumption", () => {
    const runtime = createRuntime();
    const agentId = "agent-1";
    const convId = "conv-1";

    // Populate
    populateInterruptQueue(runtime, {
      lastExecutionResults: [
        {
          type: "approval",
          tool_call_id: "call-1",
          approve: false,
          reason: "cancelled",
        },
      ],
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: [],
      agentId,
      conversationId: convId,
    });

    // First consume — gets the results
    const first = consumeInterruptQueue(runtime, agentId, convId);
    expect(first).not.toBeNull();

    // Second consume — queue is empty, returns null
    const second = consumeInterruptQueue(runtime, agentId, convId);
    expect(second).toBeNull();
  });

  test("third message also gets null (queue stays drained)", () => {
    const runtime = createRuntime();
    const agentId = "agent-1";
    const convId = "conv-1";

    populateInterruptQueue(runtime, {
      lastExecutionResults: [
        { type: "approval", tool_call_id: "call-1", approve: true },
      ],
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: [],
      agentId,
      conversationId: convId,
    });

    consumeInterruptQueue(runtime, agentId, convId); // first
    consumeInterruptQueue(runtime, agentId, convId); // second
    const third = consumeInterruptQueue(runtime, agentId, convId);
    expect(third).toBeNull();
  });
});

describe("idempotency: first cancel populates, second is no-op", () => {
  test("second populateInterruptQueue returns false and preserves first results", () => {
    const runtime = createRuntime();

    const first = populateInterruptQueue(runtime, {
      lastExecutionResults: [
        { type: "approval", tool_call_id: "call-first", approve: true },
      ],
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: [],
      agentId: "agent-1",
      conversationId: "conv-1",
    });
    expect(first).toBe(true);

    const second = populateInterruptQueue(runtime, {
      lastExecutionResults: [
        {
          type: "approval",
          tool_call_id: "call-second",
          approve: false,
          reason: "x",
        },
      ],
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: [],
      agentId: "agent-1",
      conversationId: "conv-1",
    });
    expect(second).toBe(false);

    // First results preserved
    expect(runtime.pendingInterruptedResults?.[0]).toMatchObject({
      tool_call_id: "call-first",
    });
  });

  test("populate succeeds again after consume clears the queue", () => {
    const runtime = createRuntime();

    populateInterruptQueue(runtime, {
      lastExecutionResults: [
        { type: "approval", tool_call_id: "call-1", approve: true },
      ],
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: [],
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    // Consume clears
    consumeInterruptQueue(runtime, "agent-1", "conv-1");

    // Re-populate succeeds
    const repopulated = populateInterruptQueue(runtime, {
      lastExecutionResults: [
        { type: "approval", tool_call_id: "call-2", approve: true },
      ],
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: [],
      agentId: "agent-1",
      conversationId: "conv-1",
    });
    expect(repopulated).toBe(true);
    expect(runtime.pendingInterruptedResults?.[0]).toMatchObject({
      tool_call_id: "call-2",
    });
  });
});

describe("epoch guard: stale context discarded on consume", () => {
  test("consume returns null for queue populated in earlier epoch", () => {
    const runtime = createRuntime();
    runtime.socket = new MockSocket(WebSocket.OPEN) as unknown as WebSocket;

    // Populate at epoch 0
    populateInterruptQueue(runtime, {
      lastExecutionResults: [
        { type: "approval", tool_call_id: "call-1", approve: true },
      ],
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: [],
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    // Stop bumps epoch, also clears — but let's test the guard directly:
    // Manually bump epoch without clearing (simulating a theoretical race)
    runtime.continuationEpoch = 99;

    const consumed = consumeInterruptQueue(runtime, "agent-1", "conv-1");
    // Context has epoch 0, runtime has epoch 99 → mismatch → no consumption
    expect(consumed).toBeNull();
    // But queue IS cleared (atomic clear regardless of match)
    expect(runtime.pendingInterruptedResults).toBeNull();
  });

  test("consume returns null for queue with wrong agentId", () => {
    const runtime = createRuntime();

    populateInterruptQueue(runtime, {
      lastExecutionResults: [
        { type: "approval", tool_call_id: "call-1", approve: true },
      ],
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: [],
      agentId: "agent-old",
      conversationId: "conv-1",
    });

    const consumed = consumeInterruptQueue(runtime, "agent-new", "conv-1");
    expect(consumed).toBeNull();
    // Cleared regardless
    expect(runtime.pendingInterruptedResults).toBeNull();
  });

  test("consume returns null for queue with wrong conversationId", () => {
    const runtime = createRuntime();

    populateInterruptQueue(runtime, {
      lastExecutionResults: [
        { type: "approval", tool_call_id: "call-1", approve: true },
      ],
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: [],
      agentId: "agent-1",
      conversationId: "conv-old",
    });

    const consumed = consumeInterruptQueue(runtime, "agent-1", "conv-new");
    expect(consumed).toBeNull();
  });
});

describe("stale Path-B IDs: clearing after successful send prevents re-denial", () => {
  test("populate with cleared IDs after send produces no Path B denials", () => {
    const runtime = createRuntime();

    // After successful send: both lastExecutionResults and lastNeedsUserInputToolCallIds cleared
    // Also batch map should be cleared by clearPendingApprovalBatchIds
    const populated = populateInterruptQueue(runtime, {
      lastExecutionResults: null,
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: [], // cleared after send
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    expect(populated).toBe(false);
    expect(runtime.pendingInterruptedResults).toBeNull();
  });

  test("batch map as primary Path B source after send still works if not cleared", () => {
    const runtime = createRuntime();

    // Batch map still has entries (from a NEW approval round that wasn't sent yet)
    runtime.pendingApprovalBatchByToolCallId.set("call-new-1", "batch-new");

    const populated = populateInterruptQueue(runtime, {
      lastExecutionResults: null,
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: [], // cleared from previous send
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    expect(populated).toBe(true);
    expect(runtime.pendingInterruptedResults).toHaveLength(1);
    expect(runtime.pendingInterruptedResults?.[0]).toMatchObject({
      tool_call_id: "call-new-1",
      approve: false,
    });
  });
});

describe("cancel-induced stop reason reclassification", () => {
  /**
   * Mirrors the effectiveStopReason computation from the Case 3 stream path.
   * Both the legacy and canonical listener branches use effectiveStopReason.
   * This test verifies the reclassification logic those branches depend on.
   */
  function computeEffectiveStopReason(
    cancelRequested: boolean,
    rawStopReason: string | null,
  ): string {
    return cancelRequested ? "cancelled" : rawStopReason || "error";
  }

  test("backend 'error' is reclassified to 'cancelled' when cancel was requested", () => {
    const effective = computeEffectiveStopReason(true, "error");
    expect(effective).toBe("cancelled");
  });

  test("backend 'error' is preserved when cancel was NOT requested", () => {
    const effective = computeEffectiveStopReason(false, "error");
    expect(effective).toBe("error");
  });

  test("null stop reason defaults to 'error' when cancel was NOT requested", () => {
    const effective = computeEffectiveStopReason(false, null);
    expect(effective).toBe("error");
  });

  test("any raw stop reason is overridden to 'cancelled' when cancel was requested", () => {
    expect(computeEffectiveStopReason(true, "llm_api_error")).toBe("cancelled");
    expect(computeEffectiveStopReason(true, "end_turn")).toBe("cancelled");
    expect(computeEffectiveStopReason(true, null)).toBe("cancelled");
  });

  test("runtime.lastStopReason tracks the effective value after cancel populate", () => {
    const runtime = createRuntime();
    runtime.cancelRequested = true;

    // After cancel, the production code sets:
    //   runtime.lastStopReason = effectiveStopReason
    // where effectiveStopReason = cancelRequested ? "cancelled" : rawStop
    const rawFromBackend = "error";
    const effective = computeEffectiveStopReason(
      runtime.cancelRequested,
      rawFromBackend,
    );
    runtime.lastStopReason = effective;

    expect(runtime.lastStopReason).toBe("cancelled");
  });
});

describe("consume clears pendingApprovalBatchByToolCallId", () => {
  test("batch map is cleared as part of atomic consumption", () => {
    const runtime = createRuntime();

    runtime.pendingApprovalBatchByToolCallId.set("call-1", "batch-1");
    populateInterruptQueue(runtime, {
      lastExecutionResults: [
        { type: "approval", tool_call_id: "call-1", approve: true },
      ],
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: [],
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    consumeInterruptQueue(runtime, "agent-1", "conv-1");

    expect(runtime.pendingApprovalBatchByToolCallId.size).toBe(0);
  });

  test("batch map is cleared even when context doesn't match (discard path)", () => {
    const runtime = createRuntime();

    runtime.pendingApprovalBatchByToolCallId.set("call-1", "batch-1");
    populateInterruptQueue(runtime, {
      lastExecutionResults: [
        { type: "approval", tool_call_id: "call-1", approve: true },
      ],
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: [],
      agentId: "agent-old",
      conversationId: "conv-old",
    });

    // Different agent → context mismatch → discard, but still clears
    consumeInterruptQueue(runtime, "agent-new", "conv-new");

    expect(runtime.pendingApprovalBatchByToolCallId.size).toBe(0);
  });
});
