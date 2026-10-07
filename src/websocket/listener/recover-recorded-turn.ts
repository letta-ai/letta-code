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
import {
  dispositionKey,
  durableTransaction,
  getLedger,
  hasCompletedInputTerminalRevision,
  loadDurableQueuedInputEntries,
  syncMemoryFromDurable,
  teleportInputIdentity,
} from "./input-disposition";
import {
  hasPreparedInputTerminalRevision,
  prepareInputTerminal,
} from "./input-terminal-journal";
import {
  createInterruptedTurnStore,
  type InterruptedTurnRecord,
  recordedToolResults,
} from "./interrupted-turn-record";
import {
  markRecoveryClaimCompletionPending,
  retireAcknowledgedRecoveryClaim,
} from "./recovery-claim-completion";
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
import type { ConversationRuntime, ListenerRuntime } from "./types";

function hasCompletedTeleportInput(
  listener: ListenerRuntime,
  runtimeKey: string,
  teleportId: string,
): boolean {
  const ledger = getLedger(listener);
  const key = dispositionKey(runtimeKey, teleportInputIdentity(teleportId));
  const matches = () => {
    const entry = ledger.entries.get(key);
    return entry?.replayCompleted === true && entry.queuedInput === undefined;
  };
  if (!ledger.persistentPath) return matches();
  return durableTransaction(ledger.persistentPath, (store) => {
    syncMemoryFromDurable(ledger, store);
    return { result: matches(), changed: false };
  });
}

function prepareRecordedInputTerminal(
  listener: ListenerRuntime,
  terminalStore: ReturnType<typeof createTurnFinishedStore>,
  runtime: ConversationRuntime,
  record: InterruptedTurnRecord,
  runId: string | null,
): boolean {
  const identities = record.durableInputIdentities ?? [];
  if (!identities.length || !record.revision) return true;
  const scope = {
    agentId: record.agentId,
    conversationId: record.conversationId,
  };
  if (
    hasCompletedInputTerminalRevision(
      listener,
      runtime.key,
      identities,
      record.revision,
    )
  ) {
    return true;
  }
  const eligibleConnections = [...listener.connections.values()]
    .filter(
      (connection) =>
        connection.initialized && connection.subscriptions.has(runtime.key),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const activeConnection = runtime.activeConnectionId
    ? listener.connections.get(runtime.activeConnectionId)
    : undefined;
  const ownerConnection =
    activeConnection?.initialized &&
    activeConnection.subscriptions.has(runtime.key)
      ? activeConnection
      : eligibleConnections.find(
          (connection) => connection.options.connectionIdCanResume !== false,
        );
  const owner = getTurnFinishedOwner(runtime, record.revision);
  owner.connectionId = ownerConnection?.id ?? null;
  owner.canRotate = ownerConnection?.options.connectionIdCanResume === false;
  owner.lineageId = ownerConnection?.startupOwner.lineageId ?? null;
  if (
    !prepareInputTerminal(runtime, identities, {
      scope,
      message: {
        type: "turn_finished",
        turn_id: `turn-recovered-complete-${randomUUID()}`,
        stop_reason: "end_turn",
        ...(record.terminalConsumerIds?.length
          ? { terminal_consumer_ids: [...new Set(record.terminalConsumerIds)] }
          : {}),
        ...(runId ? { run_id: runId } : {}),
      },
      owner,
    })
  ) {
    return false;
  }
  promotePreparedInputTerminals(listener, terminalStore, scope);
  return !hasPreparedInputTerminalRevision(listener, scope, record.revision);
}

export function scheduleRecordedTurnRecovery(
  listener: ListenerRuntime,
  recover = recoverRecordedTurns,
  retryDelayMs = 5000,
): void {
  if (scheduledRecoveries.has(listener)) return;
  scheduledRecoveries.add(listener);
  setImmediate(() => {
    scheduledRecoveries.delete(listener);
    if (listener !== getActiveRuntime() || listener.intentionallyClosed) return;
    if (recovering.has(listener)) {
      pendingRecoveries.add(listener);
      return;
    }
    void recover(listener).catch((error) => {
      debugWarn("recovery", "Recorded restart recovery failed", error);
      if (listener !== getActiveRuntime() || listener.intentionallyClosed)
        return;
      const previous = retryTimers.get(listener);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        retryTimers.delete(listener);
        scheduleRecordedTurnRecovery(listener, recover, retryDelayMs);
      }, retryDelayMs);
      retryTimers.set(listener, timer);
      timer.unref();
    });
  });
}

const scheduledRecoveries = new WeakSet<ListenerRuntime>();
const recovering = new WeakSet<ListenerRuntime>();
const pendingRecoveries = new WeakSet<ListenerRuntime>();
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
    retryDelayMs: number;
  }> = {},
): Promise<void> {
  if (
    !listener.connectionId?.startsWith("conn-") ||
    listener.intentionallyClosed
  )
    return;
  if (recovering.has(listener)) {
    pendingRecoveries.add(listener);
    return;
  }
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
          !record.teleport &&
          !record.teleportId &&
          !record.recoveryClaimCompletion &&
          (hasCompletedInputTerminalRevision(
            listener,
            getConversationRuntimeKey(record.agentId, record.conversationId),
            record.durableInputIdentities ?? [],
            record.revision ?? null,
          ) ||
            terminalStore
              .read(record.agentId, record.conversationId)
              ?.terminals.some(
                (terminal) =>
                  terminal.owner.interruptedRevision === record.revision,
              ))
        ) {
          if (
            !store.remove(
              record.agentId,
              record.conversationId,
              record.revision,
            )
          ) {
            deferred = true;
          }
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
        if (record.recoveryClaimCompletion?.state === "pending") {
          const eligibility = await resolveRecoveryEligibility(
            runtime,
            deps.canRecover,
          );
          if (eligibility !== "owned") {
            deferred = true;
            continue;
          }
          if (!unchanged()) {
            deferred = true;
            continue;
          }
          recoveryClaim = await (deps.acquireClaim ?? acquireRecoveryClaim)(
            runtime,
            () =>
              scheduleRecordedTurnRecovery(listener, () =>
                recoverRecordedTurns(listener, deps),
              ),
          );
          if (!recoveryClaim) {
            deferred = true;
            continue;
          }
          if (!unchanged()) {
            await recoveryClaim.release();
            recoveryClaim = undefined;
            deferred = true;
            continue;
          }
          if (!(await recoveryClaim.complete())) {
            recoveryClaim.abandon();
            recoveryClaim = undefined;
            deferred = true;
            continue;
          }
          recoveryClaim = undefined;
          const retirement = record.revision
            ? retireAcknowledgedRecoveryClaim(store, {
                agentId: record.agentId,
                conversationId: record.conversationId,
                lineageId: record.recoveryClaimCompletion.lineageId,
                pendingRevision: record.revision,
              })
            : "failed";
          if (retirement === "failed" || retirement === "preserved") {
            deferred = true;
          }
          continue;
        }
        const runningCompletion = record.recoveryClaimCompletion;
        if (
          runningCompletion?.state === "running" &&
          runningCompletion.independentSuccessor &&
          runningCompletion.effectRevision &&
          (hasCompletedInputTerminalRevision(
            listener,
            runtime.key,
            record.durableInputIdentities ?? [],
            runningCompletion.effectRevision,
          ) ||
            terminalStore
              .read(record.agentId, record.conversationId)
              ?.terminals.some(
                (terminal) =>
                  terminal.owner.interruptedRevision ===
                  runningCompletion.effectRevision,
              ))
        ) {
          const eligibility = await resolveRecoveryEligibility(
            runtime,
            deps.canRecover,
          );
          if (eligibility !== "owned" || !unchanged()) {
            deferred = true;
            continue;
          }
          recoveryClaim = await (deps.acquireClaim ?? acquireRecoveryClaim)(
            runtime,
            () =>
              scheduleRecordedTurnRecovery(listener, () =>
                recoverRecordedTurns(listener, deps),
              ),
          );
          if (!recoveryClaim?.owned || !unchanged()) {
            await recoveryClaim?.release();
            recoveryClaim = undefined;
            deferred = true;
            continue;
          }
          const pendingCompletion = markRecoveryClaimCompletionPending(
            store,
            record,
          );
          if (
            !pendingCompletion?.revision ||
            !recoveryClaim.owned ||
            !(await recoveryClaim.complete())
          ) {
            recoveryClaim.abandon();
            recoveryClaim = undefined;
            deferred = true;
            continue;
          }
          recoveryClaim = undefined;
          const retirement = retireAcknowledgedRecoveryClaim(store, {
            agentId: record.agentId,
            conversationId: record.conversationId,
            lineageId: runningCompletion.lineageId,
            pendingRevision: pendingCompletion.revision,
          });
          if (retirement !== "removed" && retirement !== "stale") {
            deferred = true;
          }
          continue;
        }
        const teleportId = record.teleport?.teleportId ?? record.teleportId;
        if (teleportId) {
          const teleport = await (deps.teleportStatus ?? getTeleportStatus)(
            record.agentId,
            record.conversationId,
            teleportId,
          );
          if (!unchanged()) {
            deferred = true;
            continue;
          }
          if (teleport.status === "completed") {
            if (
              !store.remove(
                record.agentId,
                record.conversationId,
                record.revision ?? null,
              )
            ) {
              deferred = true;
            }
          } else if (teleport.status === "failed") {
            // Once teleport_failed durably admits its continuation, that payload
            // contains the original Cloud error text and is the idempotent proof
            // that this stale intent was consumed. Restart may clear it without
            // waiting for event redelivery; otherwise retain it fail-closed.
            const failureWasAdmitted =
              loadDurableQueuedInputEntries(listener).some(
                ({ disposition, payload }) =>
                  (disposition === "queued" || disposition === "started") &&
                  payload.scope.agentId === record.agentId &&
                  payload.scope.conversationId === record.conversationId &&
                  payload.identity.domain === "teleport" &&
                  payload.identity.id === teleportId,
              ) ||
              hasCompletedTeleportInput(
                listener,
                getConversationRuntimeKey(
                  record.agentId,
                  record.conversationId,
                ),
                teleportId,
              );
            if (
              !failureWasAdmitted ||
              !record.teleport ||
              !store.remove(
                record.agentId,
                record.conversationId,
                record.revision ?? null,
              )
            ) {
              // Admission/completion proof durably owns continuation of this
              // failed teleport, so the exact predecessor has no remaining
              // purpose. CAS loss means a successor now owns the record; leave
              // it intact and revisit it through the coalesced recovery pass.
              deferred = true;
            }
          } else if (
            record.teleport &&
            !record.teleport.ready &&
            record.revision
          ) {
            const teleportIntent = record.teleport;
            const eligibility = await resolveRecoveryEligibility(
              runtime,
              deps.canRecover,
            );
            if (eligibility !== "owned" || !unchanged()) {
              deferred = true;
              continue;
            }
            recoveryClaim = await (deps.acquireClaim ?? acquireRecoveryClaim)(
              runtime,
              () =>
                scheduleRecordedTurnRecovery(listener, () =>
                  recoverRecordedTurns(listener, deps),
                ),
            );
            if (!recoveryClaim?.owned || !unchanged()) {
              await recoveryClaim?.release();
              recoveryClaim = undefined;
              deferred = true;
              continue;
            }
            const terminalReady =
              !teleportIntent.activeTurn ||
              prepareRecordedInputTerminal(
                listener,
                terminalStore,
                runtime,
                record,
                record.runId,
              );
            if (!terminalReady || !recoveryClaim.owned || !unchanged()) {
              await recoveryClaim.release();
              recoveryClaim = undefined;
              deferred = true;
              continue;
            }
            try {
              store.write(
                {
                  ...record,
                  teleport: {
                    ...teleportIntent,
                    ready: true,
                    committedRevision: record.revision,
                  },
                },
                record.revision,
              );
            } catch {
              deferred = true;
            }
            await recoveryClaim.release();
            recoveryClaim = undefined;
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
        if (!unchanged()) {
          deferred = true;
          continue;
        }
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
          if (!unchanged()) {
            deferred = true;
            continue;
          }
          if (run?.status === "running" || run?.status === "created") {
            deferred = true;
            continue;
          }
          if (record.recoveryClaimCompletion?.state === "running") {
            const eligibility = await resolveRecoveryEligibility(
              runtime,
              deps.canRecover,
            );
            if (eligibility !== "owned" || !unchanged()) {
              deferred = true;
              continue;
            }
            recoveryClaim = await (deps.acquireClaim ?? acquireRecoveryClaim)(
              runtime,
              () =>
                scheduleRecordedTurnRecovery(listener, () =>
                  recoverRecordedTurns(listener, deps),
                ),
            );
            if (!recoveryClaim) {
              deferred = true;
              continue;
            }
            if (!unchanged()) {
              await recoveryClaim.release();
              recoveryClaim = undefined;
              deferred = true;
              continue;
            }
            if (
              !prepareRecordedInputTerminal(
                listener,
                terminalStore,
                runtime,
                record,
                recordedRunId,
              )
            ) {
              await recoveryClaim.release();
              recoveryClaim = undefined;
              deferred = true;
              continue;
            }
            const pendingCompletion = markRecoveryClaimCompletionPending(
              store,
              record,
            );
            if (!pendingCompletion?.revision) {
              await recoveryClaim.release();
              recoveryClaim = undefined;
              deferred = true;
              continue;
            }
            if (!recoveryClaim.owned || !(await recoveryClaim.complete())) {
              recoveryClaim.abandon();
              recoveryClaim = undefined;
              deferred = true;
              continue;
            }
            recoveryClaim = undefined;
            const retirement = retireAcknowledgedRecoveryClaim(store, {
              agentId: record.agentId,
              conversationId: record.conversationId,
              lineageId: record.recoveryClaimCompletion.lineageId,
              pendingRevision: pendingCompletion.revision,
            });
            if (retirement === "failed" || retirement === "preserved") {
              deferred = true;
            }
            continue;
          }
          const completionEligibility = await resolveRecoveryEligibility(
            runtime,
            deps.canRecover,
          );
          if (completionEligibility !== "owned" || !unchanged()) {
            deferred = true;
            continue;
          }
          recoveryClaim = await (deps.acquireClaim ?? acquireRecoveryClaim)(
            runtime,
            () =>
              scheduleRecordedTurnRecovery(listener, () =>
                recoverRecordedTurns(listener, deps),
              ),
          );
          if (!recoveryClaim?.owned || !unchanged()) {
            await recoveryClaim?.release();
            recoveryClaim = undefined;
            deferred = true;
            continue;
          }
          if (
            !prepareRecordedInputTerminal(
              listener,
              terminalStore,
              runtime,
              record,
              recordedRunId,
            ) ||
            !recoveryClaim.owned ||
            !unchanged()
          ) {
            await recoveryClaim.release();
            recoveryClaim = undefined;
            deferred = true;
            continue;
          }
          const removed = store.remove(
            record.agentId,
            record.conversationId,
            record.revision ?? null,
          );
          await recoveryClaim.release();
          recoveryClaim = undefined;
          if (!removed) deferred = true;
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
        if (!unchanged()) {
          deferred = true;
          continue;
        }
        if (!owned.length) {
          if (
            !store.remove(
              record.agentId,
              record.conversationId,
              record.revision ?? null,
            )
          ) {
            deferred = true;
          }
          continue;
        }
        if (owned.length !== pending.length) {
          deferred = true;
          continue;
        }
        const eligibility = await resolveRecoveryEligibility(
          runtime,
          deps.canRecover,
        );
        if (eligibility !== "owned") {
          deferred = true;
          continue;
        }
        if (!unchanged()) {
          deferred = true;
          continue;
        }
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
          deferred = true;
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
        const recoveryLineageId = randomUUID();
        const persistedContinuation = store.write(
          {
            ...continuation,
            recoveryClaimCompletion: {
              lineageId: recoveryLineageId,
              state: "running",
            },
          },
          record.revision ?? null,
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
          false,
          persistedContinuation.revision,
          recoveryClaim !== null && recoveryClaim !== undefined,
          recoveryLineageId,
        );
        continuationStarted = true;
        void continuationPromise
          .then(async () => {
            const completed = store.read(
              continuation.agentId,
              continuation.conversationId,
            );
            if (
              !completed?.revision ||
              completed.recoveryClaimCompletion?.lineageId !== recoveryLineageId
            ) {
              scheduleRecordedTurnRecovery(listener, () =>
                recoverRecordedTurns(listener, deps),
              );
              return;
            }
            const pendingCompletion = markRecoveryClaimCompletionPending(
              store,
              completed,
            );
            if (!pendingCompletion) {
              scheduleRecordedTurnRecovery(listener, () =>
                recoverRecordedTurns(listener, deps),
              );
              return;
            }
            if (recoveryClaim && !(await recoveryClaim.complete())) {
              recoveryClaim.abandon();
              scheduleRecordedTurnRecovery(listener, () =>
                recoverRecordedTurns(listener, deps),
              );
              return;
            }
            const retirement = pendingCompletion.revision
              ? retireAcknowledgedRecoveryClaim(store, {
                  agentId: continuation.agentId,
                  conversationId: continuation.conversationId,
                  lineageId: recoveryLineageId,
                  pendingRevision: pendingCompletion.revision,
                })
              : "failed";
            if (retirement === "failed" || retirement === "preserved") {
              scheduleRecordedTurnRecovery(listener, () =>
                recoverRecordedTurns(listener, deps),
              );
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
    if (pendingRecoveries.delete(listener)) {
      scheduleRecordedTurnRecovery(
        listener,
        () => recoverRecordedTurns(listener, deps),
        deps.retryDelayMs,
      );
    } else if (deferred && !listener.intentionallyClosed) {
      const retryDelayMs = deps.retryDelayMs ?? 5000;
      const timer = setTimeout(() => {
        retryTimers.delete(listener);
        scheduleRecordedTurnRecovery(
          listener,
          () => recoverRecordedTurns(listener, deps),
          retryDelayMs,
        );
      }, retryDelayMs);
      timer.unref();
      retryTimers.set(listener, timer);
    }
  }
}
