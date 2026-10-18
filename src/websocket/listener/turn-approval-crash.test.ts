import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  createInterruptedTurnStore,
  type InterruptedTurnRecord,
  recordedToolResults,
} from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { RECOVERED_APPROVAL_OUTCOME_UNKNOWN } from "./recovered-approval-checkpoint";
import { handleApprovalStop } from "./turn-approval";

test("a thrown approval batch checkpoints failure before reconnect delivery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-thrown-checkpoint-"));
  try {
    const store = createInterruptedTurnStore(directory);
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
      toolCallId: "call-thrown",
      toolName: "Bash",
      toolArgs: '{"command":"pwd"}',
    };
    let transportOpen = true;
    let durableRecord: InterruptedTurnRecord = {
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-thrown",
      toolCallIds: [],
      results: [],
      requestOtid: "initial-otid",
      workingDirectory: process.cwd(),
    };
    let preEffectResults: InterruptedTurnRecord["results"] = [];
    let preEffectShouldContinue: (() => boolean) | undefined;
    let enterTransportWait!: () => void;
    const transportWaitEntered = new Promise<void>((resolve) => {
      enterTransportWait = resolve;
    });
    let releaseTransportWait!: () => void;
    const transportWait = new Promise<"interrupted">((resolve) => {
      releaseTransportWait = () => resolve("interrupted");
    });

    const approvalPromise = handleApprovalStop({
      approvals: [approval],
      runtime,
      socket: {
        kind: "runtime",
        bufferedAmount: 0,
        isOpen: () => transportOpen,
        send: () => {},
      },
      agentId: "agent-1",
      conversationId: "conv-1",
      turnWorkingDirectory: process.cwd(),
      turnPermissionModeState: { mode: "strict" },
      dequeuedBatchId: "batch-thrown",
      msgRunIds: [],
      turnInput: { messages: [] },
      pendingNormalizationInterruptedToolCallIds: [],
      turnToolContextId: null,
      turnLease,
      buildSendOptions: () =>
        ({
          agentId: "agent-1",
          streamTokens: true,
          background: true,
          workingDirectory: process.cwd(),
        }) as never,
      dependencies: {
        classifyApprovals: async () => ({
          autoAllowed: [
            { approval, parsedArgs: { command: "pwd" }, context: null },
          ],
          autoDenied: [],
          needsUserInput: [],
        }),
        executeApprovalBatch: async (
          _decisions: unknown,
          _onChunk: unknown,
          options?: {
            beforeToolExecution?: (toolCallId: string) => void | Promise<void>;
          },
        ) => {
          await options?.beforeToolExecution?.(approval.toolCallId);
          preEffectResults = structuredClone(durableRecord.results);
          transportOpen = false;
          throw new Error("batch exploded after execution boundary");
        },
        ensureSecretsHydrated: async () => {},
        recordListenerWork: (
          _runtime: typeof runtime,
          update: Partial<InterruptedTurnRecord>,
          phase: string,
          _expectedRevision: string | null | undefined,
          _recoveryLineageId: string | undefined,
          options?: { shouldContinue?: () => boolean },
        ) => {
          if (phase === "before_tool_execution") {
            preEffectShouldContinue = options?.shouldContinue;
          }
          durableRecord = { ...durableRecord, ...update };
          store.write(durableRecord);
        },
        waitForApprovalTransportOpen: async () => {
          enterTransportWait();
          return transportWait;
        },
      } as never,
    });

    await transportWaitEntered;
    expect(preEffectResults).toEqual([
      {
        type: "tool",
        tool_call_id: approval.toolCallId,
        status: "error",
        tool_return: RECOVERED_APPROVAL_OUTCOME_UNKNOWN,
      },
    ]);
    const recovered = createInterruptedTurnStore(directory).read(
      "agent-1",
      "conv-1",
    );
    expect(recovered?.results).toEqual([
      expect.objectContaining({
        type: "tool",
        tool_call_id: approval.toolCallId,
        status: "error",
        tool_return: RECOVERED_APPROVAL_OUTCOME_UNKNOWN,
      }),
    ]);
    expect(
      recovered && recordedToolResults(recovered, [approval.toolCallId]),
    ).toEqual(recovered?.results ?? null);
    expect(preEffectShouldContinue?.()).toBe(true);

    runtime.turnLifecycle.requestCancellation({ cause: "transport" });
    expect(preEffectShouldContinue?.()).toBe(false);
    releaseTransportWait();
    await expect(approvalPromise).rejects.toThrow(
      "batch exploded after execution boundary",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("authority loss waits for effects and checkpoints exact returned results", async () => {
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-1",
    "conv-1",
  );
  const turnLease = runtime.turnLifecycle.begin({
    origin: "approval_recovery",
    workingDirectory: process.cwd(),
    initialStatus: "PROCESSING_API_RESPONSE",
  });
  const approval = {
    toolCallId: "call-settles",
    toolName: "Bash",
    toolArgs: '{"command":"deploy"}',
  };
  let authority = true;
  let executionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    executionStarted = resolve;
  });
  let settleExecution!: (value: unknown[]) => void;
  const execution = new Promise<unknown[]>((resolve) => {
    settleExecution = resolve;
  });
  const checkpoints: Array<Partial<InterruptedTurnRecord>> = [];

  const resultPromise = handleApprovalStop({
    approvals: [approval],
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
    dequeuedBatchId: "batch-settles",
    msgRunIds: [],
    turnInput: { messages: [] },
    pendingNormalizationInterruptedToolCallIds: [],
    turnToolContextId: null,
    turnLease,
    processOwnedTurn: true,
    authorityGuard: () => authority,
    buildSendOptions: () => ({}) as never,
    dependencies: {
      classifyApprovals: async () => ({
        autoAllowed: [
          { approval, parsedArgs: { command: "deploy" }, context: null },
        ],
        autoDenied: [],
        needsUserInput: [],
      }),
      executeApprovalBatch: (async () => {
        executionStarted();
        return await execution;
      }) as never,
      ensureSecretsHydrated: async () => {},
      recordListenerWork: (
        _owner: unknown,
        update: Partial<InterruptedTurnRecord>,
      ) => checkpoints.push(update),
    } as never,
  });

  await started;
  authority = false;
  const exact = {
    type: "tool" as const,
    tool_call_id: "call-settles",
    status: "success" as const,
    tool_return: "deployed",
  };
  settleExecution([exact]);
  const result = await resultPromise;

  expect(turnLease.signal.aborted).toBe(false);
  expect(result.kind).toBe("interrupted");
  expect(checkpoints.at(-1)?.results).toEqual([exact]);
});
