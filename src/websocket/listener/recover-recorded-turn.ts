import { randomUUID } from "node:crypto";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import { getBackend } from "@/backend";
import { getTeleportStatus } from "@/backend/api/environments";
import { isInteractiveApprovalTool } from "@/tools/interactive-policy";
import { debugWarn } from "@/utils/debug";
import { getOrCreateProcessTransport } from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { setConversationWorkingDirectory } from "./cwd";
import {
  createInterruptedTurnStore,
  recordedToolResults,
} from "./interrupted-turn-record";
import { canRecoverConversation } from "./recovery-ownership";
import { getActiveRuntime } from "./runtime";
import { handleIncomingMessage } from "./turn";
import type { ListenerRuntime } from "./types";

export function scheduleRecordedTurnRecovery(
  listener: ListenerRuntime,
  recover = recoverRecordedTurns,
): void {
  setImmediate(() => {
    if (listener !== getActiveRuntime() || listener.intentionallyClosed) return;
    void recover(listener).catch((error) => {
      debugWarn("recovery", "Recorded restart recovery failed", error);
    });
  });
}

const recovering = new WeakSet<ListenerRuntime>();
const retryTimers = new WeakMap<
  ListenerRuntime,
  ReturnType<typeof setTimeout>
>();

/** Reconnect can retry a deferred record, but observing a conversation creates none. */
export async function recoverRecordedTurns(
  listener: ListenerRuntime,
  deps: Partial<{
    store: ReturnType<typeof createInterruptedTurnStore>;
    backend: ReturnType<typeof getBackend>;
    resume: typeof getResumeDataFromBackend;
    canRecover: typeof canRecoverConversation;
    processTurn: typeof handleIncomingMessage;
    setCwd: typeof setConversationWorkingDirectory;
    teleportStatus: typeof getTeleportStatus;
  }> = {},
): Promise<void> {
  if (
    !listener.connectionId?.startsWith("conn-") ||
    listener.intentionallyClosed ||
    recovering.has(listener)
  )
    return;
  recovering.add(listener);
  const timer = retryTimers.get(listener);
  if (timer) clearTimeout(timer);
  retryTimers.delete(listener);
  const store = deps.store ?? createInterruptedTurnStore();
  const canRecover = deps.canRecover ?? canRecoverConversation;
  let deferred = false;
  try {
    for (const record of store.list()) {
      const runtime = getOrCreateScopedRuntime(
        listener,
        record.agentId,
        record.conversationId,
      );
      const unchanged = () =>
        runtime.turnLifecycle.kind === "idle" &&
        !listener.intentionallyClosed &&
        store.read(record.agentId, record.conversationId)?.revision ===
          record.revision;
      if (runtime.turnLifecycle.kind !== "idle") continue;
      if (!(await canRecover(runtime))) {
        deferred = true;
        continue;
      }
      try {
        if (record.teleportId) {
          const teleport = await (deps.teleportStatus ?? getTeleportStatus)(
            record.agentId,
            record.conversationId,
            record.teleportId,
          );
          if (!unchanged()) continue;
          if (teleport.status === "completed") {
            store.remove(record.agentId, record.conversationId);
          } else if (teleport.status === "failed") {
            store.write({ ...record, teleportId: undefined });
            deferred = true;
          } else {
            deferred = true;
          }
          continue;
        }
        const backend = deps.backend ?? getBackend();
        const agent = await backend.retrieveAgent(record.agentId);
        const pending = (
          await (deps.resume ?? getResumeDataFromBackend)(
            agent,
            record.conversationId,
            { includeMessageHistory: false },
          )
        ).pendingApprovals;
        if (!unchanged()) continue;
        // A run can finish generating its tool call while its listener is down.
        // Require the stored approval message to name the recorded run in that case.
        let recordedRunId = record.runId;
        if (
          record.results.length &&
          (!pending.length ||
            pending.some(
              (approval) => !record.toolCallIds.includes(approval.toolCallId),
            ))
        ) {
          // The result POST may have been accepted just before this process
          // died, before it received the new run ID. Resolve its exact OTID.
          const stream = await backend.streamConversationMessages(
            record.conversationId,
            {
              otid: record.requestOtid,
              starting_after: 0,
              ...(record.conversationId === "default"
                ? { agent_id: record.agentId }
                : {}),
            },
            { signal: AbortSignal.timeout(5000), maxRetries: 0 },
          );
          try {
            for await (const chunk of stream) {
              if ("run_id" in chunk && typeof chunk.run_id === "string") {
                recordedRunId = chunk.run_id;
                break;
              }
            }
          } finally {
            stream.controller.abort();
          }
        }
        if (!pending.length) {
          const run = recordedRunId
            ? await backend.retrieveRun(recordedRunId)
            : null;
          if (!unchanged()) continue;
          if (run?.status === "running" || run?.status === "created") {
            deferred = true;
            continue;
          }
          store.remove(record.agentId, record.conversationId);
          continue;
        }
        const owned = [];
        for (const approval of pending) {
          if (record.toolCallIds.includes(approval.toolCallId)) {
            owned.push(approval);
            continue;
          }
          if (!approval.messageId || !recordedRunId) continue;
          const messages = await backend.retrieveMessage(approval.messageId);
          if (
            messages.some(
              (message) =>
                "run_id" in message && message.run_id === recordedRunId,
            )
          )
            owned.push(approval);
        }
        if (!unchanged()) continue;
        if (!owned.length) {
          store.remove(record.agentId, record.conversationId);
          continue;
        }
        if (owned.length !== pending.length) continue;
        // Questions still require a human answer; browser sync re-presents them.
        if (
          owned.some((approval) => isInteractiveApprovalTool(approval.toolName))
        )
          continue;
        if (!(await canRecover(runtime))) continue;
        if (!unchanged()) continue;
        const approvals = recordedToolResults(
          record,
          owned.map((approval) => approval.toolCallId),
        );
        const continuation = owned.every((approval) =>
          record.toolCallIds.includes(approval.toolCallId),
        )
          ? record
          : {
              ...record,
              toolCallIds: owned.map((approval) => approval.toolCallId),
              results: approvals,
              requestOtid: randomUUID(),
            };
        store.write(continuation);
        // An observer sync may have parked generic stale denials. The saved
        // results below replace those, rather than appending a second result.
        runtime.pendingInterruptedResults = null;
        runtime.pendingInterruptedContext = null;
        runtime.pendingInterruptedToolCallIds = null;
        (deps.setCwd ?? setConversationWorkingDirectory)(
          listener,
          record.agentId,
          record.conversationId,
          record.workingDirectory,
        );
        void (deps.processTurn ?? handleIncomingMessage)(
          {
            type: "message",
            agentId: record.agentId,
            conversationId: record.conversationId,
            actingUserId: record.actingUserId,
            messages: [
              { type: "approval", approvals, otid: continuation.requestOtid },
            ],
          },
          getOrCreateProcessTransport(listener),
          runtime,
        ).catch((error) => {
          debugWarn(
            "recovery",
            "Recorded continuation failed; retaining local work",
            error,
          );
        });
      } catch (error) {
        deferred = true;
        debugWarn(
          "recovery",
          "Recorded turn recovery failed; retaining local work",
          error,
        );
      }
    }
  } finally {
    recovering.delete(listener);
    if (deferred && !listener.intentionallyClosed) {
      const timer = setTimeout(() => {
        void recoverRecordedTurns(listener, deps);
      }, 5000);
      timer.unref();
      retryTimers.set(listener, timer);
    }
  }
}
