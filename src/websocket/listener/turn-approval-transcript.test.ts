import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createBuffers,
  onChunk,
  removeIncompleteTools,
  toLines,
} from "@/cli/helpers/accumulator";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { handleApprovalStop } from "./turn-approval";

test("listener approval preserves a completed MessageChannel reply in the transcript", async () => {
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-1",
    "conv-1",
  );
  const turnLease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
    initialStatus: "PROCESSING_API_RESPONSE",
  });
  const approval = {
    toolCallId: "call-channel",
    toolName: "MessageChannel",
    toolArgs: JSON.stringify({ message: "The channel reply" }),
  };
  const buffers = createBuffers("agent-1");
  onChunk(buffers, {
    message_type: "approval_request_message",
    id: "request-channel",
    date: new Date().toISOString(),
    tool_call: {
      tool_call_id: approval.toolCallId,
      name: approval.toolName,
      arguments: approval.toolArgs,
    },
  });
  expect(toLines(buffers)).toEqual([
    expect.objectContaining({ phase: "ready", name: "MessageChannel" }),
  ]);
  await handleApprovalStop({
    approvals: [approval],
    onChunk: (chunk) => onChunk(buffers, chunk),
    runtime,
    socket: {
      kind: "runtime",
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {},
    },
    agentId: "agent-1",
    conversationId: "conv-1",
    turnWorkingDirectory: process.cwd(),
    turnPermissionModeState: { mode: "strict" },
    dequeuedBatchId: "batch-channel",
    msgRunIds: [],
    turnInput: { messages: [] },
    pendingNormalizationInterruptedToolCallIds: [],
    turnToolContextId: null,
    turnLease,
    buildSendOptions: () => ({}),
    dependencies: {
      classifyApprovals: async () => ({
        autoAllowed: [
          {
            approval,
            permission: { decision: "allow" },
            parsedArgs: JSON.parse(approval.toolArgs),
            context: null,
          },
        ],
        autoDenied: [],
        needsUserInput: [],
      }),
      executeApprovalBatch: async (_decisions, emitChunk) => {
        emitChunk?.({
          message_type: "tool_return_message",
          id: "return-channel",
          date: new Date().toISOString(),
          tool_call_id: approval.toolCallId,
          status: "success",
          tool_return: "Message sent",
        });
        return [
          {
            type: "tool",
            tool_call_id: approval.toolCallId,
            status: "success",
            tool_return: "Message sent",
          },
        ];
      },
      ensureSecretsHydrated: async () => {},
      recordListenerWork: async () => {},
      sendApprovalContinuation: async () => ({
        kind: "stream",
        stream: {} as never,
      }),
    },
  });
  removeIncompleteTools(buffers);
  expect(toLines(buffers)).toEqual([
    expect.objectContaining({
      name: "MessageChannel",
      phase: "finished",
      argsText: approval.toolArgs,
      resultText: "Message sent",
      resultOk: true,
    }),
  ]);
  // Ensure the production turn supplies its own transcript accumulator too.
  const source = readFileSync(new URL("./turn.ts", import.meta.url), "utf8");
  expect(source).toContain("onChunk: (chunk) => onChunk(buffers, chunk)");
});
