import { afterEach, expect, test } from "bun:test";
import { clearAllSubagents, registerSubagent } from "@/agent/subagent-state";
import { trackChildSend } from "@/agent/subagents/child-send-tracking";
import type { EnqueueReceipt } from "@/backend/api/conversation-enqueue";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime as createListenerRuntime } from "./lifecycle";
import { buildSubagentSnapshot } from "./protocol-outbound";

const parentScope = { agentId: "agent-parent", conversationId: "conv-parent" };
const scope = { agent_id: "agent-parent", conversation_id: "conv-parent" };

afterEach(() => {
  clearAllSubagents();
});

test("serializes the exact child enqueue receipt Super Run without claiming the parent", async () => {
  const receipt: EnqueueReceipt = {
    status: "queued",
    agent_id: "agent-child",
    conversation_id: "conv-child",
    client_message_id: "cm-child",
    workflow_id: "wf-child",
    super_run_id: "sr-exact-child-receipt",
  };
  let settle!: () => void;
  const run = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const id = trackChildSend({
    receipt,
    child: { name: "Child", type: "general-purpose" },
    prompt: "Finish the task",
    parentScope,
    waitForRun: () => run,
  });
  const listener = createListenerRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    scope.agent_id,
    scope.conversation_id,
  );

  try {
    const serialized = JSON.parse(
      JSON.stringify(buildSubagentSnapshot(runtime, scope)),
    );
    expect(serialized).toEqual([
      expect.objectContaining({
        subagent_id: id,
        conversation_id: receipt.conversation_id,
        super_run_id: receipt.super_run_id,
        is_background: true,
        claims_parent_runtime: false,
      }),
    ]);
  } finally {
    settle();
    await run;
    await Promise.resolve();
  }
});

test("ordinary subagents omit Super Run identity from serialized snapshots", () => {
  registerSubagent(
    "ordinary-child",
    "general-purpose",
    "Task child",
    undefined,
    false,
    false,
    parentScope,
  );
  const listener = createListenerRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    scope.agent_id,
    scope.conversation_id,
  );
  const serialized = JSON.parse(
    JSON.stringify(buildSubagentSnapshot(runtime, scope)),
  );

  expect(serialized).toHaveLength(1);
  expect(serialized[0].subagent_id).toBe("ordinary-child");
  expect(serialized[0]).not.toHaveProperty("super_run_id");
});
