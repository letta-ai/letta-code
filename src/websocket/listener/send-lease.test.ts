import { describe, expect, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { clearConversationRuntimeState } from "./runtime";
import { resolveStaleApprovals } from "./send";
import type { ListenerTransport } from "./transport";

function createTransport(): ListenerTransport {
  return {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
}

function createPreparedToolContext() {
  return {
    toolset: "codex",
    toolsetPreference: "auto",
    preparedToolContext: {
      contextId: "context-1",
      loadedToolNames: [],
      clientTools: [],
      clientSkills: [],
    },
  } as never;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for stale approval preparation");
}

describe("pre-stream recovery lease boundaries", () => {
  test("a reset during tool preparation cannot consume replacement input", async () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    const staleLease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
      initialStatus: "WAITING_FOR_API_RESPONSE",
    });
    let preparationStarted = false;
    let finishPreparation!: (value: never) => void;
    const preparation = new Promise<never>((resolve) => {
      finishPreparation = resolve;
    });
    const approval = {
      toolCallId: "call-1",
      toolName: "Bash",
      toolArgs: '{"command":"pwd"}',
    };
    const recovery = resolveStaleApprovals(
      runtime,
      createTransport(),
      staleLease,
      {
        retrieveAgent: async () => ({ id: "agent-1" }) as never,
        getResumeData: async () => ({
          pendingApproval: approval,
          pendingApprovals: [approval],
          messageHistory: [],
        }),
        prepareToolExecutionContext: (async () => {
          preparationStarted = true;
          return preparation;
        }) as never,
      },
    );
    await waitFor(() => preparationStarted);

    clearConversationRuntimeState(runtime);
    const replacementLease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    enqueueInboundUserMessage(runtime, {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      messages: [{ role: "user", content: "replacement input" }],
    });
    finishPreparation(createPreparedToolContext());

    await expect(recovery).rejects.toThrow(/Cancelled/);
    expect(runtime.turnLifecycle.isCurrent(replacementLease)).toBe(true);
    expect(runtime.currentToolset).toBeNull();
    expect(runtime.queueRuntime.length).toBe(1);
    expect(runtime.queuedMessagesByItemId.size).toBe(1);
  });
});
