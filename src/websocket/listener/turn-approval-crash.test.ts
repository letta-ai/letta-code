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
        executeApprovalBatch: async () => {
          transportOpen = false;
          throw new Error("batch exploded after execution boundary");
        },
        ensureSecretsHydrated: async () => {},
        recordListenerWork: (
          _runtime: typeof runtime,
          update: Partial<InterruptedTurnRecord>,
        ) => {
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
    const recovered = createInterruptedTurnStore(directory).read(
      "agent-1",
      "conv-1",
    );
    expect(recovered?.results).toEqual([
      expect.objectContaining({
        type: "tool",
        tool_call_id: approval.toolCallId,
        status: "error",
        tool_return:
          "Approval batch failed: Error: batch exploded after execution boundary",
      }),
    ]);
    expect(
      recovered && recordedToolResults(recovered, [approval.toolCallId]),
    ).toEqual(recovered?.results ?? null);

    runtime.turnLifecycle.requestCancellation({ cause: "transport" });
    releaseTransportWait();
    await expect(approvalPromise).rejects.toThrow(
      "batch exploded after execution boundary",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
