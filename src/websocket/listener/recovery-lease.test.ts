import { describe, expect, mock, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { resolveRecoveredApprovalResponse } from "./recovery";
import {
  clearConversationRuntimeState,
  getPendingControlRequestCount,
} from "./runtime";
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

function createRecoveredState(
  pendingRequestIds: Set<string> = new Set(["perm-1"]),
): RecoveredApprovalState {
  return {
    agentId: "agent-1",
    conversationId: "conv-1",
    approvalsByRequestId: new Map([
      [
        "perm-1",
        {
          approval: {
            toolCallId: "call-1",
            toolName: "Bash",
            toolArgs: '{"command":"pwd"}',
          },
          approvalContext: null,
          controlRequest: {
            type: "control_request",
            request_id: "perm-1",
            request: {
              subtype: "can_use_tool",
              tool_name: "Bash",
              input: { command: "pwd" },
              tool_call_id: "call-1",
              permission_suggestions: [],
              blocked_path: null,
            },
            agent_id: "agent-1",
            conversation_id: "conv-1",
          },
        },
      ],
    ]),
    pendingRequestIds,
    responsesByRequestId: new Map(),
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
  throw new Error("Timed out waiting for recovered approval state");
}

describe("recovered approval lease boundaries", () => {
  test("the last pending gate is removed only after recovery owns the lifecycle", async () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    let lifecycleKindAtDelete: string | null = null;
    const pendingRequestIds = new (class extends Set<string> {
      override delete(value: string): boolean {
        lifecycleKindAtDelete = runtime.turnLifecycle.kind;
        return super.delete(value);
      }
    })(["perm-1"]);
    runtime.recoveredApprovalState = createRecoveredState(pendingRequestIds);
    let releasePermissionWrite!: (saved: boolean) => void;
    let permissionWriteStarted = false;
    const permissionWrite = new Promise<boolean>((resolve) => {
      releasePermissionWrite = resolve;
    });

    const handled = resolveRecoveredApprovalResponse(
      runtime,
      createTransport([]),
      { request_id: "perm-1", decision: { behavior: "allow" } },
      async (
        _message,
        _socket,
        ownerRuntime,
        _onStatusChange,
        _connectionId,
        _batchId,
        turnLease,
      ) => {
        if (turnLease) ownerRuntime.turnLifecycle.finish(turnLease, "end_turn");
      },
      {
        dependencies: {
          applySuggestedPermissions: async () => {
            permissionWriteStarted = true;
            return permissionWrite;
          },
          ensureSecretsHydrated: async () => {},
          prepareToolExecutionContext: async () => createPreparedToolContext(),
          executeApprovalBatch: async () => [],
        },
      },
    );
    await waitFor(() => permissionWriteStarted);

    expect(
      getPendingControlRequestCount(runtime.listener, {
        agent_id: "agent-1",
        conversation_id: "conv-1",
      }),
    ).toBe(1);
    expect(runtime.turnLifecycle.kind).toBe("idle");

    releasePermissionWrite(false);
    expect(await handled).toBe(true);
    expect(String(lifecycleKindAtDelete)).toBe("active");
  });

  test("stale recovered tool execution emits nothing into a replacement run", async () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    runtime.recoveredApprovalState = createRecoveredState();
    const sentPayloads: string[] = [];
    let executionStarted = false;
    let resolveExecution!: (results: never[]) => void;
    const execution = new Promise<never[]>((resolve) => {
      resolveExecution = resolve;
    });
    const processTurn = mock(async () => {});
    const handled = resolveRecoveredApprovalResponse(
      runtime,
      createTransport(sentPayloads),
      { request_id: "perm-1", decision: { behavior: "allow" } },
      processTurn,
      {
        dependencies: {
          applySuggestedPermissions: async () => false,
          ensureSecretsHydrated: async () => {},
          prepareToolExecutionContext: async () => createPreparedToolContext(),
          executeApprovalBatch: (async (
            _decisions: unknown,
            _unused: unknown,
            options?: {
              onStreamingOutput?: (id: string, chunk: string) => void;
            },
          ) => {
            executionStarted = true;
            const results = await execution;
            options?.onStreamingOutput?.("call-1", "late output");
            return results;
          }) as never,
        },
      },
    );
    await waitFor(() => executionStarted);

    clearConversationRuntimeState(runtime);
    const replacementLease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    runtime.turnLifecycle.setRunId(replacementLease, "replacement-run");
    sentPayloads.length = 0;
    resolveExecution([
      {
        type: "tool",
        tool_call_id: "call-1",
        status: "success",
        tool_return: "ok",
      },
    ] as never[]);

    expect(await handled).toBe(true);
    expect(processTurn).not.toHaveBeenCalled();
    expect(runtime.turnLifecycle.isCurrent(replacementLease)).toBe(true);
    expect(sentPayloads).toEqual([]);
  });

  test("aborted recovered execution that throws still closes lifecycle starts exactly once", async () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    runtime.recoveredApprovalState = createRecoveredState();
    const sentPayloads: string[] = [];
    let executionStarted = false;
    let rejectExecution!: (error: Error) => void;
    const execution = new Promise<never[]>((_, reject) => {
      rejectExecution = reject;
    });
    const handled = resolveRecoveredApprovalResponse(
      runtime,
      createTransport(sentPayloads),
      { request_id: "perm-1", decision: { behavior: "allow" } },
      mock(async () => {}),
      {
        dependencies: {
          applySuggestedPermissions: async () => false,
          ensureSecretsHydrated: async () => {},
          prepareToolExecutionContext: async () => createPreparedToolContext(),
          executeApprovalBatch: (async () => {
            executionStarted = true;
            return execution;
          }) as never,
        },
      },
    );
    await waitFor(() => executionStarted);

    // Abort the recovery mid-execution, then have execution reject. Unlike
    // the normal turn path, recovered approvals do not unwind through the
    // turn.ts interrupt emission, so the recovery catch itself must close
    // the client_tool_start lifecycle events even when aborted.
    runtime.turnLifecycle.requestCancellation();
    rejectExecution(new Error("tool execution crashed"));
    await handled.catch(() => {});

    const deltas = sentPayloads
      .map((payload) => JSON.parse(payload))
      .filter((frame) => frame.type === "stream_delta")
      .map((frame) => frame.delta);
    const starts = deltas.filter(
      (delta) => delta.message_type === "client_tool_start",
    );
    const ends = deltas.filter(
      (delta) => delta.message_type === "client_tool_end",
    );
    expect(starts.map((delta) => delta.tool_call_id)).toEqual(["call-1"]);
    expect(ends.map((delta) => delta.tool_call_id)).toEqual(["call-1"]);
    expect(ends[0].status).toBe("error");
  });
});
