import { expect, mock, test } from "bun:test";
import type { executeTool } from "@/tools/manager";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { startRecoveredApprovalContinuation } from "./recovery";
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
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for recovered approval execution");
}

test("production batch waits for crossed effects before scheduling claim-loss recovery", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const approvals = [
    {
      toolCallId: "call-a",
      toolName: "Write",
      toolArgs: '{"file_path":"/tmp/shared","content":"a"}',
    },
    {
      toolCallId: "call-b",
      toolName: "Write",
      toolArgs: '{"file_path":"/tmp/shared","content":"b"}',
    },
  ];
  runtime.recoveredApprovalState = {
    agentId: "agent-1",
    conversationId: "conv-1",
    actingUserId: "actor-original",
    durableInputIdentities: [{ domain: "input", id: "scheduled-parallel" }],
    terminalConsumerIds: ["slack:agent-1"],
    autoDecisions: approvals.map((approval) => ({
      type: "approve" as const,
      approval,
    })),
    allApprovals: approvals,
  };
  const scheduleRecordedRecovery = mock(() => {});
  listener.scheduleRecordedRecovery = scheduleRecordedRecovery;
  let owned = true;
  let reportClaimLoss = () => {};
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const executed: string[] = [];
  const evidence: Array<{ results?: unknown[] }> = [];
  let revision = 0;
  const processTurn = mock(async () => {});
  const execute: typeof executeTool = async (_name, _args, options) => {
    const toolCallId = options?.toolCallId ?? "missing";
    executed.push(toolCallId);
    if (toolCallId === "call-a") {
      owned = false;
      reportClaimLoss();
      await firstBlocked;
      return { status: "success", toolReturn: "effect-a-completed" };
    }
    throw new Error("call-b crossed the execution boundary");
  };
  const handled = startRecoveredApprovalContinuation(
    runtime,
    createTransport(),
    processTurn,
    {
      dependencies: {
        recoveryAuthorityStore: {
          readRecoverySnapshot: () => null,
          withRecoveryAuthority: ({ action }) => action(),
        },
        ensureSecretsHydrated: async () => {},
        ensureModAdapters: async () => [],
        prepareToolExecutionContext: async (params) => {
          expect(params.actingUserId).toBe("actor-original");
          return createPreparedToolContext();
        },
        executeTool: execute,
        recordListenerWork: (_runtime, update) => {
          evidence.push(update);
          revision += 1;
          return `revision-${revision}`;
        },
        mergeSettledRecoveryResult: async (_runtime, _lineageId, result) => {
          evidence.push({ results: [result] });
          revision += 1;
          return {
            revision: `revision-${revision}`,
            independentSuccessor: false,
          };
        },
        acquireRecoveryClaim: (async (
          _runtime: unknown,
          onLost: () => void,
        ) => {
          reportClaimLoss = onLost;
          return {
            get owned() {
              return owned;
            },
            complete: async () => false,
            release: async () => {},
            abandon: () => {},
          };
        }) as never,
      },
    },
  );
  let returned = false;
  void handled.then(() => {
    returned = true;
  });

  await waitFor(() => executed.includes("call-a"));
  await Promise.resolve();
  expect(returned).toBe(false);
  expect(scheduleRecordedRecovery).not.toHaveBeenCalled();
  expect(executed).toEqual(["call-a"]);

  releaseFirst();
  expect(await handled).toBe(true);
  expect(scheduleRecordedRecovery).toHaveBeenCalledTimes(1);
  expect(processTurn).not.toHaveBeenCalled();
  expect(evidence.at(-1)?.results).toEqual([
    expect.objectContaining({
      tool_call_id: "call-a",
      status: "success",
      tool_return: "effect-a-completed",
    }),
  ]);
  listener.intentionallyClosed = true;
});

test("unattributed recovered queued continuation suppresses ambient attribution", async () => {
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-1",
    "conv-1",
  );
  const approval = {
    toolCallId: "call-unattributed",
    toolName: "Read",
    toolArgs: '{"file_path":"/tmp/example"}',
  };
  runtime.recoveredApprovalState = {
    agentId: "agent-1",
    conversationId: "conv-1",
    autoDecisions: [{ type: "deny", approval, reason: "interrupted" }],
    allApprovals: [approval],
  };
  enqueueInboundUserMessage(runtime, {
    type: "message",
    agentId: "agent-1",
    conversationId: "conv-1",
    messages: [{ role: "user", content: "system continuation" }],
  });
  let received:
    | { actingUserId?: string; suppressActingUserFallback?: boolean }
    | undefined;
  let preparedActor:
    | { actingUserId?: string; suppressActingUserFallback?: boolean }
    | undefined;

  const handled = await startRecoveredApprovalContinuation(
    runtime,
    createTransport(),
    async (message, _socket, ownerRuntime, ...args) => {
      received = message;
      const turnLease = args[3];
      if (turnLease) ownerRuntime.turnLifecycle.finish(turnLease, "end_turn");
    },
    {
      dependencies: {
        ensureSecretsHydrated: async () => {},
        ensureModAdapters: async () => [],
        prepareToolExecutionContext: async (params) => {
          preparedActor = params;
          return createPreparedToolContext();
        },
        executeApprovalBatch: async () => [],
        recordListenerWork: () => {},
      },
    },
  );

  expect(handled).toBe(true);
  expect(received?.actingUserId).toBeUndefined();
  expect(received?.suppressActingUserFallback).toBe(true);
  expect(preparedActor?.actingUserId).toBeUndefined();
  expect(preparedActor?.suppressActingUserFallback).toBe(true);
});
