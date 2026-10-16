import { describe, expect, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { consumeQueuedTurn } from "./queue";

function scopedRuntime() {
  return getOrCreateScopedRuntime(createRuntime(), "agent-1", "conv-1");
}

describe("queued turn process ownership", () => {
  test("a cron-only batch is process-owned", () => {
    // Without this flag the approval path waits for a subscribed client after
    // tool execution, so an unattended scheduled turn stalls after its first
    // tools with the results checkpointed but never submitted.
    const runtime = scopedRuntime();
    runtime.queueRuntime.enqueue({
      kind: "cron_prompt",
      source: "cron",
      text: "scheduled check",
      cronTaskId: "task-1",
      agentId: "agent-1",
      conversationId: "conv-1",
    } as never);

    const consumed = consumeQueuedTurn(runtime);
    expect(consumed?.queuedTurn.processOwnedTurn).toBe(true);
  });

  test("a client message batch is not process-owned", () => {
    const runtime = scopedRuntime();
    expect(
      enqueueInboundUserMessage(runtime, {
        type: "message",
        agentId: "agent-1",
        conversationId: "conv-1",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hi" }],
            otid: "otid-1",
            client_message_id: "otid-1",
          },
        ],
      }),
    ).toBe(true);

    const consumed = consumeQueuedTurn(runtime);
    expect(consumed?.queuedTurn.processOwnedTurn).toBeUndefined();
  });
});
