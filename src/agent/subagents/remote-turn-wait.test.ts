import { expect, test } from "bun:test";
import type { EnqueueReceipt } from "@/backend/api/conversation-enqueue";
import { collectRemoteTurnResult } from "./remote-turn-wait";
import type { ExecutionState } from "./subagent-stream";

const receipt: EnqueueReceipt = {
  status: "queued",
  agent_id: "agent-1",
  conversation_id: "conv-1",
  client_message_id: "cm-1",
  super_run_id: "sr-1",
  workflow_id: "wf-1",
  connection_id: "conn-1",
};
function state(): ExecutionState {
  return {
    agentId: null,
    conversationId: null,
    finalResult: null,
    finalError: null,
    enqueueReceipt: receipt,
    resultStats: null,
    displayedToolCalls: new Set(),
  };
}

test("task abort delegates cancellation of the accepted input, including its listener", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const result = await collectRemoteTurnResult(
    receipt,
    state(),
    "test-remote",
    controller.signal,
    {
      wait: async () => {
        controller.abort();
        throw new Error("aborted");
      },
      cancel: async (input) => {
        expect(input).toEqual(receipt);
        cancelled = true;
        return true;
      },
    },
  );
  expect(cancelled).toBe(true);
  expect(result.success).toBe(false);
  expect(result.error).not.toContain("could not confirm");
});

test("successful receipt tracking produces the task report", async () => {
  const result = await collectRemoteTurnResult(
    receipt,
    state(),
    "test-remote",
    undefined,
    {
      wait: async () => ({
        text: "done",
        runIds: ["run-1"],
        stopReason: "end_turn",
      }),
    },
  );
  expect(result).toMatchObject({
    success: true,
    report: "done",
    conversationId: "conv-1",
  });
});
