import { describe, expect, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { clearConversationRuntimeState } from "./runtime";
import { resolveStaleApprovals, sendMessageStreamWithRetry } from "./send";
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
  throw new Error("Timed out waiting for stale approval preparation");
}

describe("pre-stream recovery lease boundaries", () => {
  test("lost recovery authority fences backend submission before entry", async () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    const lease = runtime.turnLifecycle.begin({
      origin: "approval_recovery",
      workingDirectory: process.cwd(),
    });

    await expect(
      sendMessageStreamWithRetry(
        "conv-1",
        [{ role: "user", content: "must not submit" }],
        {},
        createTransport(),
        runtime,
        lease,
        { authorityGuard: () => false },
      ),
    ).rejects.toThrow("Recovery ownership lost");
    expect(runtime.turnLifecycle.snapshot().loopStatus).not.toBe(
      "WAITING_FOR_API_RESPONSE",
    );
  });

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

  test.each([
    {
      name: "attributed",
      agentId: "agent-1",
      queuedUser: "cloud-user-charles",
      expectedActor: null,
    },
    {
      name: "unattributed",
      agentId: "agent-1",
      queuedUser: undefined,
      expectedActor: null,
    },
    {
      name: "conversation-owned",
      agentId: null,
      queuedUser: undefined,
      expectedActor: null,
    },
  ])(
    "an $name queued user's work waits for a new turn after pre-stream approval recovery",
    async ({ queuedUser, expectedActor, agentId }) => {
      const runtime = getOrCreateScopedRuntime(
        createRuntime(),
        agentId,
        "conv-1",
      );
      const turnLease = runtime.turnLifecycle.begin({
        origin: "message",
        workingDirectory: process.cwd(),
        initialStatus: "WAITING_FOR_API_RESPONSE",
      });
      enqueueInboundUserMessage(
        runtime,
        {
          type: "message",
          agentId,
          conversationId: "conv-1",
          mcpOriginatorSuperRunId: "queued-run",
          mcpOriginatorTokenPresent: true,
          messages: [
            {
              role: "user",
              content: "message from Charles",
              client_message_id: "cm-charles",
            },
          ],
        },
        queuedUser,
      );
      const approval = {
        toolCallId: "call-1",
        toolName: "Bash",
        toolArgs: '{"command":"pwd"}',
      };
      let sentActingUserId: string | null | undefined;
      let sentMessages: unknown;

      const result = await resolveStaleApprovals(
        runtime,
        createTransport(),
        turnLease,
        {
          retrieveAgent: async () => ({ id: "agent-1" }) as never,
          retrieveConversation: async () =>
            ({
              id: "conv-1",
              agent_id: null,
              model: "openai/gpt-5.6-luna",
            }) as never,
          getResumeData: async () => ({
            pendingApproval: approval,
            pendingApprovals: [approval],
            messageHistory: [],
          }),
          prepareToolExecutionContext: async () => createPreparedToolContext(),
          sendApprovalContinuation: async (
            _conversationId,
            messages,
            options,
          ) => {
            sentActingUserId = options?.actingUserId;
            sentMessages = messages;
            return { kind: "stream" as const, stream: {} as never };
          },
          drainRecoveryStream: async (_stream, _socket, _runtime, params) => {
            params.turnCorrelation?.observeRun("run-recovery");
            return { stopReason: "end_turn", apiDurationMs: 0 } as never;
          },
        },
      );

      expect(result?.stopReason).toBe("end_turn");
      expect(sentActingUserId).toBe(expectedActor);
      expect(JSON.stringify(sentMessages)).toContain("call-1");
      expect(JSON.stringify(sentMessages)).not.toContain(
        "message from Charles",
      );
      expect(runtime.queueRuntime.length).toBe(1);
      expect(runtime.queuedMessagesByItemId.size).toBe(1);
      expect(
        runtime.listener.clientMessageIdsByRunIdByConversation
          ?.get(runtime.key)
          ?.get("run-recovery"),
      ).toBeUndefined();
    },
  );
});

describe("stale approval recovery races another client", () => {
  const call = (id: string) => ({
    toolCallId: id,
    toolName: "Bash",
    toolArgs: '{"command":"pwd"}',
  });

  // Each getResumeData call returns the next snapshot of pending approvals.
  async function recover(
    snapshots: Array<Array<ReturnType<typeof call>>>,
    send: () => Promise<{ kind: "stream"; stream: never }>,
    opts: {
      drains?: unknown[];
      batches?: Record<string, string>;
    } = {},
  ) {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    for (const [id, batch] of Object.entries(opts.batches ?? {})) {
      runtime.pendingApprovalBatchByToolCallId.set(id, batch);
    }
    const batchesAtSend: Array<Map<string, string>> = [];
    const turnLease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
      initialStatus: "WAITING_FOR_API_RESPONSE",
    });
    const sent: string[] = [];
    let fetches = 0;
    const result = resolveStaleApprovals(
      runtime,
      createTransport(),
      turnLease,
      {
        retrieveAgent: async () => ({ id: "agent-1" }) as never,
        getResumeData: async () => {
          const pending = snapshots[Math.min(fetches++, snapshots.length - 1)];
          return {
            pendingApproval: pending?.[0] ?? null,
            pendingApprovals: pending ?? [],
            messageHistory: [],
          };
        },
        prepareToolExecutionContext: async () => createPreparedToolContext(),
        sendApprovalContinuation: async (_conversationId, messages) => {
          sent.push(JSON.stringify(messages));
          batchesAtSend.push(new Map(runtime.pendingApprovalBatchByToolCallId));
          return send();
        },
        drainRecoveryStream: async () =>
          (opts.drains?.shift() ?? {
            stopReason: "end_turn",
            apiDurationMs: 0,
          }) as never,
      },
    );
    return { result, sent, batchesAtSend };
  }
  const stream = async () => ({ kind: "stream" as const, stream: {} as never });

  test("sends no denial when another client resolved the call before the deny", async () => {
    const { result, sent } = await recover([[call("call-1")], []], stream);

    await expect(result).resolves.toBeNull();
    expect(sent).toEqual([]);
  });

  test("denies only the calls that are still pending", async () => {
    const { result, sent } = await recover(
      [[call("call-1"), call("call-2")], [call("call-2")]],
      stream,
    );

    await expect(result).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("call-2");
    expect(sent[0]).not.toContain("call-1");
  });

  test("control: a call that is still pending is denied", async () => {
    const { result, sent } = await recover([[call("call-1")]], stream);

    await expect(result).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("call-1");
    expect(sent[0]).toContain('"approve":false');
  });

  test("a rejected denial for a call resolved mid-send does not error the turn", async () => {
    const { result, sent } = await recover(
      [[call("call-1")], [call("call-1")], []],
      async () => {
        throw new Error("Approval continuation conflict");
      },
    );

    await expect(result).resolves.toBeNull();
    expect(sent).toHaveLength(1);
  });

  test("a rejected denial still surfaces when the call is still pending", async () => {
    const { result } = await recover([[call("call-1")]], async () => {
      throw new Error("Approval continuation conflict");
    });

    await expect(result).rejects.toThrow("Approval continuation conflict");
  });

  test("a second round of requires_approval gets its own batch", async () => {
    const { result, sent, batchesAtSend } = await recover(
      [[call("call-1")]],
      stream,
      {
        drains: [
          {
            stopReason: "requires_approval",
            approvals: [call("call-2")],
            apiDurationMs: 0,
          },
        ],
      },
    );

    await expect(result).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("call-2");
    expect([...(batchesAtSend[1]?.keys() ?? [])]).toEqual(["call-2"]);
    expect(batchesAtSend[1]?.get("call-2")).not.toBe(
      batchesAtSend[0]?.get("call-1"),
    );
  });

  test("control: one round mixing two existing batches still fails closed", async () => {
    const { result, sent } = await recover(
      [[call("call-1"), call("call-2")]],
      stream,
      { batches: { "call-1": "batch-a", "call-2": "batch-b" } },
    );

    await expect(result).rejects.toThrow(
      "Ambiguous pending approval batch mapping during recovery",
    );
    expect(sent).toEqual([]);
  });
});
