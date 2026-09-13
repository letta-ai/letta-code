import { expect, mock, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { runListenerTurnCleanup } from "./turn-cleanup";

test("releases transient channel tools when turn finalization moved elsewhere", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const serviceCommandHandler = mock(async () => ({
    kind: "runtime_tools_released" as const,
  }));
  listener.serviceCommandHandler = serviceCommandHandler;
  runtime.transientChannelRuntimeTools = true;

  await runListenerTurnCleanup({
    runtime,
    agentId: "agent-1",
    normalizedAgentId: "agent-1",
    conversationId: "conv-1",
    finalized: false,
  });

  expect(serviceCommandHandler).toHaveBeenCalledWith({
    kind: "release_runtime_tools",
    runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
  });
  expect(runtime.transientChannelRuntimeTools).toBe(false);
});
