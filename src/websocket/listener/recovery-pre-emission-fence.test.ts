import { expect, mock, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { startRecoveredApprovalContinuation } from "./recovery";
import type { ListenerTransport } from "./transport";
import type { RecoveredApprovalState } from "./types";

function createTransport(sentPayloads: string[]): ListenerTransport {
  return {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: (payload: string) => sentPayloads.push(payload),
  };
}

function createRecoveredState(): RecoveredApprovalState {
  const approval = {
    toolCallId: "call-approved",
    toolName: "Read",
    toolArgs: '{"file_path":"/tmp/example"}',
  };
  return {
    agentId: "agent-1",
    conversationId: "conv-1",
    autoDecisions: [{ type: "approve", approval }],
    allApprovals: [approval],
  };
}

test("claim loss during onLeaseAcquired emits no observer-visible recovery state", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  runtime.recoveredApprovalState = createRecoveredState();
  const sentPayloads: string[] = [];
  const executeApprovalBatch = mock(async () => [
    {
      type: "tool" as const,
      tool_call_id: "call-approved",
      status: "success" as const,
      tool_return: "contents",
    },
  ]);
  let loseClaim!: () => void;

  expect(
    await startRecoveredApprovalContinuation(
      runtime,
      createTransport(sentPayloads),
      mock(async () => {}),
      {
        onLeaseAcquired: async () => loseClaim(),
        dependencies: {
          acquireRecoveryClaim: (async (
            _runtime: unknown,
            onLost: () => void,
          ) => {
            let owned = true;
            loseClaim = () => {
              owned = false;
              onLost();
            };
            return {
              get owned() {
                return owned;
              },
              complete: async () => false,
              release: async () => {},
              abandon: () => {},
            };
          }) as never,
          ensureSecretsHydrated: async () => {},
          ensureModAdapters: async () => [],
          prepareToolExecutionContext: async () =>
            ({
              toolset: "codex",
              toolsetPreference: "auto",
              preparedToolContext: {
                contextId: "context-1",
                loadedToolNames: [],
                clientTools: [],
                clientSkills: [],
              },
            }) as never,
          executeApprovalBatch,
        },
      },
    ),
  ).toBe(true);
  expect(sentPayloads).toEqual([]);
  expect(executeApprovalBatch).not.toHaveBeenCalled();
  expect(runtime.currentToolset).toBeNull();
  expect(runtime.turnLifecycle.kind).toBe("idle");
  listener.intentionallyClosed = true;
});
