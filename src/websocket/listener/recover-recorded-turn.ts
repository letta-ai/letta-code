import { randomUUID } from "node:crypto";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import { getBackend } from "@/backend";
import { getTeleportStatus } from "@/backend/api/environments";
import { debugWarn } from "@/utils/debug";
import { getOrCreateProcessTransport } from "./connection";
import {
  getOrCreateScopedRuntime,
  promotePreparedInputTerminals,
} from "./conversation-runtime";
import { setConversationWorkingDirectory } from "./cwd";
import { hasCompletedInputTerminalRevision } from "./input-disposition";
import {
  hasPreparedInputTerminalRevision,
  prepareInputTerminal,
} from "./input-terminal-journal";
import {
  createInterruptedTurnStore,
  recordedToolResults,
} from "./interrupted-turn-record";
import {
  acquireRecoveryClaim,
  canRecoverConversation,
  type RecoveryClaim,
  resolveRecoveryEligibility,
} from "./recovery-ownership";
import { getActiveRuntime, getConversationRuntimeKey } from "./runtime";
import { handleIncomingMessage } from "./turn";
import {
  createTurnFinishedStore,
  getTurnFinishedOwner,
} from "./turn-finished-replay";
import type { TurnLease } from "./turn-lifecycle";
import type { ListenerRuntime } from "./types";

export function scheduleRecordedTurnRecovery(
  listener: ListenerRuntime,
  recover = recoverRecordedTurns,
): void {
  if (scheduledRecoveries.has(listener)) return;
  scheduledRecoveries.add(listener);
  setImmediate(() => {
    scheduledRecoveries.delete(listener);
    if (listener !== getActiveRuntime() || listener.intentionallyClosed) return;
    void recover(listener).catch((error) => {
      debugWarn("recovery", "Recorded restart recovery failed", error);
    });
  });
}

const scheduledRecoveries = new WeakSet<ListenerRuntime>();
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
    acquireClaim: typeof acquireRecoveryClaim;
    processTurn: typeof handleIncomingMessage;
    setCwd: typeof setConversationWorkingDirectory;
    teleportStatus: typeof getTeleportStatus;
    terminalStore: ReturnType<typeof createTurnFinishedStore>;
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
  const terminalStore = deps.terminalStore ?? createTurnFinishedStore();
  const canRecover = deps.canRecover ?? canRecoverConversation;
  let deferred = false;
  try {
    for (const record of store.list()) {
      if (record.revision) {
        const scope = {
          agentId: record.agentId,
          conversationId: record.conversationId,
        };
        if (
          hasPreparedInputTerminalRevision(listener, scope, record.revision)
        ) {
          promotePreparedInputTerminals(listener, terminalStore, scope);
          if (
            hasPreparedInputTerminalRevision(listener, scope, record.revision)
          ) {
            deferred = true;
            continue;
          }
        }
        if (
          hasCompletedInputTerminalRevision(
            listener,
            getConversationRuntimeKey(record.agentId, record.conversationId),
            record.durableInputIdentities ?? [],
            record.revision,
          ) ||
          terminalStore
            .read(record.agentId, record.conversationId)
            ?.terminals.some(
              (terminal) =>
                terminal.owner.interruptedRevision === record.revision,
            )
        ) {
          store.remove(record.agentId, record.conversationId);
          continue;
        }
      }
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
      if (runtime.turnLifecycle.kind !== "idle") {
        deferred = true;
        continue;
      }
      if (!(await canRecover(runtime))) {
        deferred = true;
        continue;
      }
      let recoveryClaim: RecoveryClaim | null | undefined;
      let continuationStarted = false;
      let continuationLease: TurnLease | undefined;
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
          if (record.durableInputIdentities?.length) {
            const ownerConnection = [...listener.connections.values()].find(
              (connection) =>
                connection.initialized &&
                connection.subscriptions.has(runtime.key),
            );
            runtime.activeConnectionId = ownerConnection?.id ?? null;
            const turnId = `turn-recovered-complete-${randomUUID()}`;
            if (
              !prepareInputTerminal(runtime, record.durableInputIdentities, {
                scope: {
                  agentId: record.agentId,
                  conversationId: record.conversationId,
                },
                message: {
                  type: "turn_finished",
                  turn_id: turnId,
                  stop_reason: "end_turn",
                  ...(record.terminalConsumerIds?.length
                    ? {
                        terminal_consumer_ids: [
                          ...new Set(record.terminalConsumerIds),
                        ],
                      }
                    : {}),
                  ...(recordedRunId ? { run_id: recordedRunId } : {}),
                },
                owner: getTurnFinishedOwner(runtime, record.revision),
              })
            ) {
              deferred = true;
              continue;
            }
            promotePreparedInputTerminals(listener, terminalStore, {
              agentId: record.agentId,
              conversationId: record.conversationId,
            });
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
        const eligibility = await resolveRecoveryEligibility(
          runtime,
          deps.canRecover,
        );
        if (eligibility !== "owned") {
          if (eligibility === "unavailable") deferred = true;
          continue;
        }
        if (!unchanged()) continue;
        recoveryClaim = await (deps.acquireClaim ?? acquireRecoveryClaim)(
          runtime,
          () => {
            // Do not abort an effect which may already be committing. The
            // authority guard fences transport and terminal publication; a
            // successor starts only after this detached predecessor settles.
            scheduleRecordedTurnRecovery(listener, () =>
              recoverRecordedTurns(listener, deps),
            );
          },
        );
        if (listener.connectionId?.startsWith("conn-") && !recoveryClaim) {
          deferred = true;
          continue;
        }
        if (!unchanged()) {
          await recoveryClaim?.release();
          recoveryClaim = undefined;
          continue;
        }
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
        const persistedContinuation = store.read(
          continuation.agentId,
          continuation.conversationId,
        );
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
        continuationLease = runtime.turnLifecycle.begin({
          origin: "approval_recovery",
          workingDirectory: record.workingDirectory,
        });
        const hasRecoveryOwnership = () =>
          !recoveryClaim || recoveryClaim.owned;
        const continuationPromise = (deps.processTurn ?? handleIncomingMessage)(
          {
            type: "message",
            agentId: record.agentId,
            conversationId: record.conversationId,
            actingUserId: record.actingUserId,
            connectionId: [...listener.connections.values()].find(
              (connection) =>
                connection.initialized &&
                connection.subscriptions.has(runtime.key),
            )?.id,
            durableInputIdentities: record.durableInputIdentities,
            terminalConsumerIds: record.terminalConsumerIds,
            messages: [
              { type: "approval", approvals, otid: continuation.requestOtid },
            ],
          },
          getOrCreateProcessTransport(listener),
          runtime,
          undefined,
          undefined,
          undefined,
          continuationLease,
          undefined,
          hasRecoveryOwnership,
        );
        continuationStarted = true;
        void continuationPromise
          .then(async () => {
            if (recoveryClaim && !(await recoveryClaim.complete())) {
              if (
                continuationLease &&
                runtime.turnLifecycle.isCurrent(continuationLease)
              ) {
                runtime.turnLifecycle.requestCancellation({
                  cause: "transport",
                });
                runtime.turnLifecycle.finish(continuationLease, "cancelled");
              }
              scheduleRecordedTurnRecovery(listener, () =>
                recoverRecordedTurns(listener, deps),
              );
              return;
            }
            const current = store.read(
              continuation.agentId,
              continuation.conversationId,
            );
            if (
              current?.revision &&
              current.revision === persistedContinuation?.revision
            ) {
              store.remove(continuation.agentId, continuation.conversationId);
            }
          })
          .catch(async (error) => {
            if (
              continuationLease &&
              runtime.turnLifecycle.isCurrent(continuationLease)
            ) {
              runtime.turnLifecycle.requestCancellation({ cause: "transport" });
              runtime.turnLifecycle.finish(continuationLease, "cancelled");
            }
            await recoveryClaim?.release();
            debugWarn(
              "recovery",
              "Recorded continuation failed; retaining local work",
              error,
            );
            scheduleRecordedTurnRecovery(listener, () =>
              recoverRecordedTurns(listener, deps),
            );
          })
          .finally(() => {
            if (
              recoveryClaim &&
              !recoveryClaim.owned &&
              continuationLease &&
              runtime.turnLifecycle.isCurrent(continuationLease)
            ) {
              runtime.turnLifecycle.finish(continuationLease, "cancelled");
            }
          });
      } catch (error) {
        if (recoveryClaim && !continuationStarted) {
          await recoveryClaim.release();
        }
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
