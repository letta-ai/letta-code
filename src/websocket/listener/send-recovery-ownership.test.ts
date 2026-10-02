import { describe, expect, test } from "bun:test";
import type { AgentRuntimeStatusSnapshot } from "@/backend/api/agents";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { canRecoverConversation } from "./recovery-ownership";
import { resolveStaleApprovals } from "./send";
import type { ListenerTransport } from "./transport";

function snapshot(owner: string): AgentRuntimeStatusSnapshot {
  return {
    agent_id: "agent-1",
    snapshot_at: 0,
    statuses: [
      {
        conversation_id: "conv-1",
        state: "ACTIVE",
        active_harness: { connection_id: owner },
        loop_state: null,
        active_run_ids: [],
        last_activity_at: 0,
      },
    ],
  };
}

function setup() {
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-1",
    "conv-1",
  );
  runtime.listener.connectionId = "conn-self";
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
    initialStatus: "WAITING_FOR_API_RESPONSE",
  });
  enqueueInboundUserMessage(runtime, {
    type: "message",
    agentId: "agent-1",
    conversationId: "conv-1",
    messages: [{ role: "user", content: "inbound specialist reply" }],
  });
  const transport: ListenerTransport = {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
  const approval = {
    toolCallId: "call-running-elsewhere",
    toolName: "Bash",
    toolArgs: '{"command":"pwd"}',
  };
  return { runtime, lease, transport, approval };
}

describe("pre-stream recovery server ownership", () => {
  for (const takeoverAt of ["before", "resume", "prepare", "never"] as const) {
    test(`pre-stream recovery preserves ownership with takeover at ${takeoverAt}`, async () => {
      const { runtime, lease, transport, approval } = setup();
      let owner = takeoverAt === "before" ? "conn-other" : "conn-self";
      let sent = 0;
      const result = await resolveStaleApprovals(runtime, transport, lease, {
        canRecover: () =>
          canRecoverConversation(runtime, async () => snapshot(owner)),
        retrieveAgent: async () => ({ id: "agent-1" }) as never,
        getResumeData: async () => {
          if (takeoverAt === "resume") owner = "conn-other";
          return {
            pendingApproval: approval,
            pendingApprovals: [approval],
            messageHistory: [],
          };
        },
        prepareToolExecutionContext: async () => {
          if (takeoverAt === "prepare") owner = "conn-other";
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
        },
        sendApprovalContinuation: async () => {
          sent += 1;
          return { kind: "stream" as const, stream: {} as never };
        },
        drainRecoveryStream: async () =>
          ({ stopReason: "end_turn", apiDurationMs: 0 }) as never,
      });
      if (takeoverAt === "never") {
        expect(sent).toBe(1);
        expect(result?.stopReason).toBe("end_turn");
        expect(runtime.queueRuntime.length).toBe(0);
        expect(runtime.queuedMessagesByItemId.size).toBe(0);
      } else {
        expect(sent).toBe(0);
        expect(result).toBeNull();
        expect(runtime.queueRuntime.length).toBe(1);
        expect(runtime.queuedMessagesByItemId.size).toBe(1);
      }
      expect(runtime.turnLifecycle.isCurrent(lease)).toBe(true);
    });
  }

  test("missing ownership evidence leaves pending tools and queued input untouched", async () => {
    const { runtime, lease, transport } = setup();
    let fetched = false;
    const result = await resolveStaleApprovals(runtime, transport, lease, {
      canRecover: () =>
        canRecoverConversation(runtime, async () => {
          throw new Error("runtime status unavailable");
        }),
      retrieveAgent: async () => {
        fetched = true;
        return { id: "agent-1" } as never;
      },
      getResumeData: async () => ({
        pendingApproval: null,
        pendingApprovals: [],
        messageHistory: [],
      }),
    });
    expect(result).toBeNull();
    expect(fetched).toBe(false);
    expect(runtime.queueRuntime.length).toBe(1);
    expect(runtime.queuedMessagesByItemId.size).toBe(1);
  });
});
