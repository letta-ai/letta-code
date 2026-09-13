import { describe, expect, test } from "bun:test";
import type { ApprovalDecision } from "@/agent/approval-execution";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { recoverApprovalStateForSync } from "./recovery-sync";
import { replaySyncStateForRuntime } from "./sync-replay";
import {
  clearExpectedInboundTeleport,
  expectInboundTeleport,
  isInboundTeleportExpected,
} from "./teleport";
import type { LocalTransport } from "./transport";
import type {
  ConversationRuntime,
  IncomingMessage,
  StartListenerOptions,
} from "./types";

class MockTransport implements LocalTransport {
  readonly kind = "local" as const;
  readonly bufferedAmount = 0;
  readonly sent: string[] = [];

  isOpen(): boolean {
    return true;
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

const scope = { agent_id: "agent-1", conversation_id: "conv-1" } as const;

// The source's yielded MessageChannel call: replay-unsafe, so sync recovery
// classifies it as a stale denial with nothing waiting on a human.
const sourceYieldedApproval = {
  toolCallId: "call-message-channel-1",
  toolName: "MessageChannel",
  toolArgs: '{"action":"send","channel":"slack","message":"hi"}',
};

function connectRuntime(): {
  runtime: ConversationRuntime;
  transport: MockTransport;
} {
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-1",
    "conv-1",
  );
  const transport = new MockTransport();
  const options: StartListenerOptions = {
    connectionId: "cloud-relay",
    wsUrl: "local://cloud-relay",
    deviceId: "test-device",
    connectionName: "cloud-relay",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
  openListenerConnection({
    runtime: runtime.listener,
    connectionId: options.connectionId,
    writer: transport,
    options,
  });
  markListenerConnectionInitialized(runtime.listener, options.connectionId);
  return { runtime, transport };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for the recovered continuation");
}

async function sync(
  runtime: ConversationRuntime,
  transport: MockTransport,
  processed: IncomingMessage[],
): Promise<void> {
  await replaySyncStateForRuntime(runtime.listener, transport as never, scope, {
    recoverApprovals: false,
    forceDeviceStatus: true,
    connectionId: "cloud-relay",
    recoverApprovalStateForSync: async (scopedRuntime, recoveredScope) => {
      await recoverApprovalStateForSync(scopedRuntime, recoveredScope, {
        getBackend: (() => ({
          retrieveAgent: async () => ({ id: "agent-1" }),
        })) as never,
        getResumeDataFromBackend: (async () => ({
          pendingApproval: sourceYieldedApproval,
          pendingApprovals: [sourceYieldedApproval],
          messageHistory: [],
        })) as never,
      });
    },
    recoveredContinuationDependencies: {
      ensureSecretsHydrated: async () => {},
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
      executeApprovalBatch: (async (decisions: ApprovalDecision[]) =>
        decisions.map((decision) => ({
          type: "approval" as const,
          tool_call_id: decision.approval.toolCallId,
          approve: false,
          reason: decision.type === "deny" ? decision.reason : undefined,
        }))) as never,
    },
    processIncomingMessage: async (
      message,
      _socket,
      ownerRuntime,
      _onStatusChange,
      _connectionId,
      _batchId,
      turnLease,
    ) => {
      processed.push(message);
      if (turnLease) ownerRuntime.turnLifecycle.finish(turnLease, "end_turn");
    },
  });
}

describe("sync replay on a teleport destination", () => {
  test("does not finish the source's pending approvals while teleport_continue is expected", async () => {
    const { runtime, transport } = connectRuntime();
    const processed: IncomingMessage[] = [];
    expectInboundTeleport(runtime, "teleport-1");

    // Destination runtime_start replay, then the Slack gateway's own
    // runtime_start replay a moment later: neither may start a turn.
    await sync(runtime, transport, processed);
    await sync(runtime, transport, processed);
    await Bun.sleep(5);

    expect(processed).toHaveLength(0);
    expect(runtime.isProcessing).toBe(false);
    expect(runtime.recoveredApprovalState?.autoDecisions).toHaveLength(1);
    expect(runtime.syncApprovalRecoveryCompleted).toBe(true);
    const statusFrames = transport.sent
      .map((payload) => JSON.parse(payload))
      .filter((frame) => frame.type === "update_loop_status");
    expect(statusFrames.length).toBeGreaterThan(0);
    for (const frame of statusFrames) {
      expect(frame.loop_status.status).toBe("WAITING_ON_INPUT");
    }

    // Once the continuation has arrived (the router clears the expectation),
    // a later sync may again resume an interrupted turn on its own.
    clearExpectedInboundTeleport(runtime);
    await sync(runtime, transport, processed);
    await waitFor(() => processed.length === 1);
    expect(processed[0]?.messages[0]).toMatchObject({
      type: "approval",
      approvals: [
        expect.objectContaining({
          tool_call_id: "call-message-channel-1",
          approve: false,
        }),
      ],
    });
  });

  test("an expectation whose teleport_continue never arrived expires", async () => {
    const { runtime, transport } = connectRuntime();
    const processed: IncomingMessage[] = [];
    expectInboundTeleport(runtime, "teleport-lost");
    runtime.expectedTeleportExpiresAt = Date.now() - 1;

    expect(isInboundTeleportExpected(runtime)).toBe(false);
    expect(runtime.expectedTeleportId).toBeNull();

    await sync(runtime, transport, processed);
    await waitFor(() => processed.length === 1);
  });
});
