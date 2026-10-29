import { afterEach, expect, test } from "bun:test";
import { resetMcpOriginatorAuthority } from "@/agent/mcp-originator-authority";
import {
  clearMcpOriginatorTokens,
  getMcpOriginatorToken,
  setMcpOriginatorToken,
} from "@/agent/mcp-originator-tokens";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { consumeQueuedTurn } from "./queue";
import { handleApprovalStop } from "./turn-approval";
import { createTurnDurabilityOwnership } from "./turn-durability-ownership";
import { createQueuedTurnConsumer } from "./turn-finalizer";
import type { IncomingMessage } from "./types";

afterEach(() => {
  clearMcpOriginatorTokens();
  resetMcpOriginatorAuthority();
});

for (const [queuedId, recovery] of [
  ["B", false],
  [undefined, false],
  ["A", false],
  [undefined, true],
  ["B", true],
] as const) {
  test(`A tool result appends queued ${queuedId} unless recovering, recovery=${recovery}`, async () => {
    // Steering drains every queued input regardless of originator; only a
    // recovery continuation (approval results alone) leaves the queue alone.
    const drained = !recovery;
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    const original: IncomingMessage = {
      type: "message",
      mcpOriginatorSuperRunId: "A",
      mcpOriginatorTokenPresent: true,
      durableInputIdentities: [{ domain: "input", id: "original-A" }],
      messages: [{ role: "user", content: "original" }],
    };
    const queued: IncomingMessage = {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      mcpOriginatorSuperRunId: queuedId,
      mcpOriginatorTokenPresent: true,
      durableInputIdentities: [{ domain: "input", id: "queued-head" }],
      actingUserId: "queued-actor",
      messages: [{ role: "user", content: "queued" }],
    };
    setMcpOriginatorToken("A", "token-A");
    setMcpOriginatorToken("B", "token-B");
    const ownership = createTurnDurabilityOwnership();
    ownership.recordInput(original);
    const revision = { current: "original-revision" as string | undefined };
    const socketEvents: unknown[] = [];
    let checkpoints = 0;
    let sent: unknown;
    let actor: unknown;
    const approval = { toolCallId: "call-A", toolName: "Bash", toolArgs: "{}" };
    const result = await handleApprovalStop({
      approvals: [approval],
      runtime,
      socket: {
        kind: "local",
        bufferedAmount: 0,
        isOpen: () => true,
        send: (payload: string) => {
          socketEvents.push(JSON.parse(payload));
        },
      },
      agentId: "agent-1",
      conversationId: "conv-1",
      turnWorkingDirectory: process.cwd(),
      turnPermissionModeState: { mode: "strict" },
      dequeuedBatchId: "original-batch",
      msgRunIds: [],
      turnInput: { messages: [] },
      pendingNormalizationInterruptedToolCallIds: [],
      turnToolContextId: null,
      turnLease: lease,
      ...createQueuedTurnConsumer({
        parkedInput: recovery
          ? {
              type: "message",
              messages: [
                { type: "approval", approvals: [], otid: "recovered" },
              ],
            }
          : original,
        turnToolContextId: null,
        runtime,
        ownership,
        interruptedRevisionRef: revision,
        recoveryEvidenceWriter: () => {
          checkpoints++;
          return "queued-revision";
        },
      }),
      processOwnedTurn: true,
      buildSendOptions: () => ({ actingUserId: "original-actor" }) as never,
      dependencies: {
        classifyApprovals: async () => ({
          autoAllowed: [{ approval, parsedArgs: {}, context: null }],
          autoDenied: [],
          needsUserInput: [],
        }),
        executeApprovalBatch: async () => {
          const result = {
            type: "tool" as const,
            tool_call_id: "call-A",
            status: "success" as const,
            tool_return: "A-result",
          };
          expect(runtime.queueRuntime.length).toBe(0);
          enqueueInboundUserMessage(runtime, queued, "queued-actor");
          return [result];
        },
        ensureSecretsHydrated: async () => {},
        sendApprovalContinuation: async (
          _id: string,
          messages: unknown,
          options: { actingUserId?: string | null },
        ) => {
          sent = messages;
          actor = options.actingUserId;
          return {
            kind: "terminal",
            drainResult: { stopReason: "end_turn", apiDurationMs: 0 },
          };
        },
      } as never,
    });
    expect(result.kind).toBe("terminal");
    expect(JSON.stringify(sent)).toContain("A-result");
    expect(checkpoints).toBe(drained ? 1 : 0);
    expect(revision.current).toBe(
      drained ? "queued-revision" : "original-revision",
    );
    expect(ownership.durableInputIdentities).toHaveLength(drained ? 2 : 1);
    expect(actor).toBe(drained ? "queued-actor" : "original-actor");
    expect(runtime.queueRuntime.length).toBe(drained ? 0 : 1);
    expect(runtime.queuedMessagesByItemId.size).toBe(drained ? 0 : 1);
    expect(JSON.stringify(sent).includes('"queued"')).toBe(drained);
    // A mixed-origin drain retires the queued run's token (origin swap).
    expect(getMcpOriginatorToken("B")).toBe(
      drained && queuedId === "B" ? undefined : "token-B",
    );
    expect(JSON.stringify(socketEvents).includes("user_message")).toBe(drained);
    expect(JSON.stringify(socketEvents).includes('"content":"queued"')).toBe(
      drained,
    );
    if (!drained) {
      expect(
        consumeQueuedTurn(runtime)?.queuedTurn.mcpOriginatorSuperRunId,
      ).toBe(queuedId);
    }
  });
}
