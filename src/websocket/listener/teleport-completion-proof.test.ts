import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getOrCreateScopedRuntime,
  restoreDurableQueuedInputs,
} from "./conversation-runtime";
import {
  commitInputDisposition,
  createAcceptedInputDispositionLedger,
  reserveInputDisposition,
  teleportInputIdentity,
} from "./input-disposition";
import { completeInputReplay } from "./input-terminal-journal";
import {
  createInterruptedTurnStore,
  recordListenerWork,
} from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { recoverRecordedTurns } from "./recover-recorded-turn";
import { setActiveRuntime } from "./runtime";

function failureIncoming() {
  return {
    type: "message" as const,
    agentId: "agent-1",
    conversationId: "conv-1",
    messages: [{ role: "user" as const, content: "resume" }],
  };
}

function writeFailedTeleport(
  store: ReturnType<typeof createInterruptedTurnStore>,
  teleportId = "teleport-exact",
): void {
  store.write({
    agentId: "agent-1",
    conversationId: "conv-1",
    runId: "run-predecessor",
    toolCallIds: ["call-predecessor"],
    results: [
      {
        tool_call_id: "call-predecessor",
        status: "success",
        tool_return: "predecessor-result",
      },
    ],
    requestOtid: `request-${teleportId}`,
    actingUserId: "actor-predecessor",
    durableInputIdentities: [{ domain: "input", id: "input-predecessor" }],
    terminalConsumerIds: ["slack:agent-1"],
    workingDirectory: "/project",
    teleport: {
      teleportId,
      connectionId: "source",
      activeTurn: false,
      ready: true,
    },
  });
}

test.each(["completed", "queued", "started"] as const)(
  "%s teleport failure proof immediately retires its exact predecessor",
  async (proof) => {
    const directory = mkdtempSync(
      join(tmpdir(), `recorded-teleport-${proof}-`),
    );
    const dispositionPath = join(directory, "dispositions.json");
    const realStore = createInterruptedTurnStore(
      join(directory, "interrupted"),
    );
    const original = createRuntime();
    const restarted = createRuntime();
    let scans = 0;
    const store = {
      ...realStore,
      list: () => {
        scans += 1;
        return realStore.list();
      },
    };
    try {
      original.acceptedInputDispositionLedger =
        createAcceptedInputDispositionLedger({
          persistentPath: dispositionPath,
        });
      const originalRuntime = getOrCreateScopedRuntime(
        original,
        "agent-1",
        "conv-1",
      );
      const identity = teleportInputIdentity(`teleport-${proof}`);
      const admission = reserveInputDisposition(originalRuntime, identity);
      if (admission.kind !== "reserved")
        throw new Error("expected reservation");
      expect(
        commitInputDisposition(
          originalRuntime,
          admission.reservation,
          proof === "queued" ? "queued" : "started",
          { incoming: failureIncoming() },
        ),
      ).toBe(true);
      if (proof === "completed") {
        expect(completeInputReplay(originalRuntime, [identity])).toBe(true);
      }
      writeFailedTeleport(realStore, identity.id);

      restarted.connectionId = "conn-restarted";
      restarted.acceptedInputDispositionLedger =
        createAcceptedInputDispositionLedger({
          persistentPath: dispositionPath,
        });
      setActiveRuntime(restarted);
      const teleportStatus = mock(async () => ({ status: "failed" as const }));
      await recoverRecordedTurns(restarted, {
        store,
        backend: {
          retrieveAgent: async () => ({ id: "agent-1" }),
          streamConversationMessages: async () => {
            const stream = (async function* () {
              yield { run_id: "run-predecessor" };
            })();
            return Object.assign(stream, { controller: { abort: () => {} } });
          },
          retrieveRun: async () => null,
        } as never,
        resume: (async () => ({ pendingApprovals: [] })) as never,
        canRecover: async () => true,
        acquireClaim: (async () => ({
          owned: true,
          release: async () => {},
        })) as never,
        teleportStatus: teleportStatus as never,
        retryDelayMs: 20,
      });

      expect(scans).toBe(1);
      expect(realStore.read("agent-1", "conv-1")).toBeNull();
      expect(teleportStatus).toHaveBeenCalledTimes(1);

      // No delayed convergence window exists: durable continuation restore can
      // run immediately without inheriting predecessor teleport metadata.
      expect(restoreDurableQueuedInputs(restarted)).toBe(
        proof === "completed" ? 0 : 1,
      );
      const runtime = getOrCreateScopedRuntime(restarted, "agent-1", "conv-1");
      expect(runtime.queueRuntime.length).toBe(proof === "completed" ? 0 : 1);
      recordListenerWork(
        runtime,
        { runId: "run-successor" },
        "run_observed",
        undefined,
        undefined,
        realStore,
      );
      const successor = realStore.read("agent-1", "conv-1");
      expect(successor).toMatchObject({
        runId: "run-successor",
        toolCallIds: [],
        results: [],
      });
      expect(successor?.requestOtid).not.toBe(`request-${identity.id}`);
      expect(successor?.actingUserId).toBeUndefined();
      expect(successor?.durableInputIdentities).toBeUndefined();
      expect(successor?.terminalConsumerIds).toBeUndefined();
      expect(successor?.teleport).toBeUndefined();
      expect(successor?.teleportId).toBeUndefined();
    } finally {
      original.intentionallyClosed = true;
      restarted.intentionallyClosed = true;
      setActiveRuntime(null);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.each(["missing", "different"] as const)(
  "%s teleport completion proof retains the exact failed intent",
  async (proof) => {
    const directory = mkdtempSync(
      join(tmpdir(), `recorded-teleport-${proof}-`),
    );
    const dispositionPath = join(directory, "dispositions.json");
    const store = createInterruptedTurnStore(join(directory, "interrupted"));
    const listener = createRuntime();
    try {
      listener.connectionId = "conn-restarted";
      listener.acceptedInputDispositionLedger =
        createAcceptedInputDispositionLedger({
          persistentPath: dispositionPath,
        });
      const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
      if (proof !== "missing") {
        const identity = teleportInputIdentity(
          proof === "different" ? "teleport-other" : "teleport-exact",
        );
        const admission = reserveInputDisposition(runtime, identity);
        if (admission.kind !== "reserved")
          throw new Error("expected reservation");
        expect(
          commitInputDisposition(runtime, admission.reservation, "started", {
            incoming: failureIncoming(),
          }),
        ).toBe(true);
        if (proof === "different") {
          expect(completeInputReplay(runtime, [identity])).toBe(true);
        }
      }
      writeFailedTeleport(store);

      await recoverRecordedTurns(listener, {
        store,
        canRecover: async () => true,
        teleportStatus: (async () => ({ status: "failed" })) as never,
        retryDelayMs: 60_000,
      });
      expect(store.read("agent-1", "conv-1")?.teleport).toMatchObject({
        teleportId: "teleport-exact",
      });
    } finally {
      listener.intentionallyClosed = true;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
