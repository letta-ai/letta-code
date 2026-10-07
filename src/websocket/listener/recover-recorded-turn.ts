import { randomUUID } from "node:crypto";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import { getBackend } from "@/backend";
import { getTeleportStatus } from "@/backend/api/environments";
import type { StopReasonType } from "@/types/protocol_v2";
import { debugWarn } from "@/utils/debug";
import { getOrCreateProcessTransport } from "./connection";
import {
  getOrCreateScopedRuntime,
  promotePreparedInputTerminals,
} from "./conversation-runtime";
import { setConversationWorkingDirectory } from "./cwd";
import { loadDurableQueuedInputEntries } from "./input-disposition";
import { hasCompletedInputTerminalRevision } from "./input-terminal-evidence";
import { hasPreparedInputTerminalRevision } from "./input-terminal-journal";
import {
  allRecordedResults,
  createInterruptedTurnStore,
  recordedToolResults,
  recordListenerWork,
} from "./interrupted-turn-record";
import { resolveRecordedRunId } from "./recorded-run-resolution";
import {
  hasCompletedTeleportInput,
  hasRecordedTerminalEvidence,
  prepareRecordedInputTerminal,
} from "./recorded-turn-terminal";
import {
  markRecoveryClaimCompletionPending,
  retireAcknowledgedRecoveryClaim,
} from "./recovery-claim-completion";
import type { RecoveryEvidenceWriter } from "./recovery-evidence";
import {
  acquireRecoveryClaim,
  canRecoverConversation,
  type RecoveryClaim,
  resolveRecoveryEligibility,
} from "./recovery-ownership";
import { getActiveRuntime, getConversationRuntimeKey } from "./runtime";
import { handleIncomingMessage } from "./turn";
import { createTurnFinishedStore } from "./turn-finished-replay";
import type { TurnLease } from "./turn-lifecycle";
import type { ListenerRuntime } from "./types";

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
  const recoveryEvidenceWriter: RecoveryEvidenceWriter = (
    runtime,
    update,
    phase,
    expectedRevision,
    recoveryLineageId,
  ) =>
    recordListenerWork(
      runtime,
      update,
      phase,
      expectedRevision,
      recoveryLineageId,
      store,
    );
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
      const runningCompletion = record.recoveryClaimCompletion;
      const recoverySnapshot = runningCompletion?.independentSuccessor
        ? store.readRecoverySnapshot(
            record.agentId,
            record.conversationId,
            runningCompletion.lineageId,
          )
        : null;
      if (runningCompletion?.independentSuccessor && !recoverySnapshot) {
        deferred = true;
        continue;
      }
      const recoveryRecord = recoverySnapshot?.record ?? record;
      const terminalAuthority =
        recoverySnapshot && runningCompletion
          ? {
              revisionToken: recoverySnapshot.revisionToken,
              lineageId: runningCompletion.lineageId,
            }
          : undefined;
      const unchanged = () =>
        runtime.turnLifecycle.kind === "idle" &&
        !listener.intentionallyClosed &&
        store.read(record.agentId, record.conversationId)?.revision ===
          record.revision &&
        (recoverySnapshot === null ||
          store.readRecoverySnapshot(
            record.agentId,
            record.conversationId,
            runningCompletion?.lineageId ?? "",
          )?.revisionToken === recoverySnapshot.revisionToken);
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
        if (
          runningCompletion?.state === "running" &&
          runningCompletion.independentSuccessor &&
          runningCompletion.effectRevision &&
          hasRecordedTerminalEvidence(listener, terminalStore, {
            agentId: record.agentId,
            conversationId: record.conversationId,
            runtimeKey: runtime.key,
            identities:
              runningCompletion.effectInputIdentities ??
              record.durableInputIdentities,
            revision: runningCompletion.effectRevision,
            authorityRevision: recoverySnapshot?.revisionToken,
            recoveryLineageId: runningCompletion.lineageId,
          })
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
            recoverySnapshot?.revisionToken ?? record.revision,
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
        const teleportId =
          recoveryRecord.teleport?.teleportId ?? recoveryRecord.teleportId;
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
            if (runningCompletion?.independentSuccessor && record.revision) {
              markRecoveryClaimCompletionPending(
                store,
                record,
                recoverySnapshot?.revisionToken ?? record.revision,
              );
              deferred = true;
              continue;
            }
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
              failureWasAdmitted &&
              runningCompletion?.independentSuccessor &&
              record.revision
            ) {
              markRecoveryClaimCompletionPending(
                store,
                record,
                recoverySnapshot?.revisionToken ?? record.revision,
              );
              deferred = true;
              continue;
            }
            if (
              !failureWasAdmitted ||
              !recoveryRecord.teleport ||
              !record.revision
            ) {
              deferred = true;
            } else if (
              recoveryRecord.teleport.readyRevision === record.revision
            ) {
              // Only the revision which first published readiness may be
              // deleted wholesale. A successor can inherit the metadata while
              // carrying unrelated run/result/effect evidence.
              if (
                !store.remove(
                  record.agentId,
                  record.conversationId,
                  record.revision,
                )
              ) {
                deferred = true;
              }
            } else {
              try {
                // Legacy or inherited metadata is retired by CAS while every
                // other successor field is preserved. CAS loss rearms recovery.
                store.write(
                  { ...record, teleportId: undefined, teleport: undefined },
                  record.revision,
                );
              } catch {
                deferred = true;
              }
            }
          } else if (
            recoveryRecord.teleport &&
            !recoveryRecord.teleport.ready &&
            record.revision
          ) {
            const teleportIntent = recoveryRecord.teleport;
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
                recoveryRecord,
                recoveryRecord.runId,
                "end_turn",
                terminalAuthority,
              );
            if (!terminalReady || !recoveryClaim.owned || !unchanged()) {
              await recoveryClaim.release();
              recoveryClaim = undefined;
              deferred = true;
              continue;
            }
            try {
              if (runningCompletion?.independentSuccessor) {
                store.writeRecoveryLineageSnapshot({
                  agentId: record.agentId,
                  conversationId: record.conversationId,
                  lineageId: runningCompletion.lineageId,
                  update: {
                    teleport: {
                      ...teleportIntent,
                      ready: true,
                      committedRevision:
                        runningCompletion.effectRevision ?? record.revision,
                    },
                  },
                });
              } else {
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
              }
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
        let pending = (
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
        const recordedRunId = await resolveRecordedRunId(
          backend,
          recoveryRecord,
          pending,
        );
        if (!recordedRunId) {
          deferred = true;
          continue;
        }
        const recordedRun =
          recordedRunId && typeof backend.retrieveRun === "function"
            ? await backend.retrieveRun(recordedRunId)
            : null;
        if (!unchanged()) {
          deferred = true;
          continue;
        }
        if (
          recordedRun &&
          recordedRun.status !== "running" &&
          recordedRun.status !== "created"
        ) {
          pending = [];
        }
        if (!pending.length) {
          const run = recordedRun;
          if (!unchanged()) {
            deferred = true;
            continue;
          }
          if (run?.status === "running" || run?.status === "created") {
            deferred = true;
            continue;
          }
          const recoveredStopReason: StopReasonType =
            run?.status === "failed"
              ? "error"
              : run?.status === "cancelled"
                ? "cancelled"
                : "end_turn";
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
                runningCompletion?.independentSuccessor &&
                  runningCompletion.effectRevision
                  ? {
                      ...recoveryRecord,
                      revision: runningCompletion.effectRevision,
                    }
                  : recoveryRecord,
                recordedRunId,
                recoveredStopReason,
                terminalAuthority,
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
              recoverySnapshot?.revisionToken ?? record.revision,
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
              recoveredStopReason,
              terminalAuthority,
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
          if (recoveryRecord.toolCallIds.includes(approval.toolCallId)) {
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
          if (runningCompletion?.independentSuccessor) {
            deferred = true;
            continue;
          }
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
        const hasProvablyUnstartedApproval = owned.some((approval) =>
          recoveryRecord.unstartedToolCallIds?.includes(approval.toolCallId),
        );
        if (hasProvablyUnstartedApproval) {
          // Connection sync reconstructs these as executable approvals. Never
          // turn missing local evidence into a stale denial in the generic
          // completion path while that exact replay remains available.
          await recoveryClaim?.release();
          recoveryClaim = undefined;
          deferred = true;
          continue;
        }
        const approvals = recordedToolResults(
          recoveryRecord,
          owned.map((approval) => approval.toolCallId),
        );
        const continuation = owned.every((approval) =>
          recoveryRecord.toolCallIds.includes(approval.toolCallId),
        )
          ? recoveryRecord
          : {
              ...recoveryRecord,
              toolCallIds: owned.map((approval) => approval.toolCallId),
              results: approvals,
              requestOtid: randomUUID(),
            };
        const recoveryLineageId = runningCompletion?.lineageId ?? randomUUID();
        const persistedContinuation = runningCompletion
          ? {
              ...continuation,
              revision: recoveryRecord.revision,
              recoveryClaimCompletion: record.recoveryClaimCompletion,
            }
          : store.write(
              {
                ...continuation,
                recoveryClaimCompletion: {
                  lineageId: recoveryLineageId,
                  state: "running",
                  effectToolCallIds: continuation.toolCallIds,
                  effectRunId: continuation.runId,
                  effectRequestOtid: continuation.requestOtid,
                  effectWorkingDirectory: continuation.workingDirectory,
                  effectActingUserId: continuation.actingUserId ?? null,
                  effectResults: allRecordedResults(continuation),
                  effectUnstartedToolCallIds:
                    continuation.unstartedToolCallIds ?? [],
                  effectInputIdentities:
                    continuation.durableInputIdentities ?? [],
                  effectTerminalConsumerIds:
                    continuation.terminalConsumerIds ?? [],
                  effectTeleport: continuation.teleport,
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
          recoveryRecord.agentId,
          recoveryRecord.conversationId,
          recoveryRecord.workingDirectory,
        );
        continuationLease = runtime.turnLifecycle.begin({
          origin: "approval_recovery",
          workingDirectory: recoveryRecord.workingDirectory,
        });
        const hasRecoveryOwnership = () =>
          !recoveryClaim || recoveryClaim.owned;
        const continuationPromise = (deps.processTurn ?? handleIncomingMessage)(
          {
            type: "message",
            agentId: recoveryRecord.agentId,
            conversationId: recoveryRecord.conversationId,
            actingUserId: recoveryRecord.actingUserId,
            suppressActingUserFallback:
              recoveryRecord.actingUserId === undefined,
            connectionId: [...listener.connections.values()].find(
              (connection) =>
                connection.initialized &&
                connection.subscriptions.has(runtime.key),
            )?.id,
            durableInputIdentities: recoveryRecord.durableInputIdentities,
            terminalConsumerIds: recoveryRecord.terminalConsumerIds,
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
          recoverySnapshot?.revisionToken ?? persistedContinuation.revision,
          recoveryClaim !== null && recoveryClaim !== undefined,
          recoveryLineageId,
          recoveryRecord.revision,
          store,
          recoveryEvidenceWriter,
        );
        continuationStarted = true;
        void continuationPromise
          .then(async () => {
            const completedSnapshot = store.readRecoverySnapshot(
              continuation.agentId,
              continuation.conversationId,
              recoveryLineageId,
            );
            const completed = completedSnapshot?.record;
            if (
              !completed?.revision ||
              completed.recoveryClaimCompletion?.lineageId !==
                recoveryLineageId ||
              !hasRecordedTerminalEvidence(listener, terminalStore, {
                agentId: continuation.agentId,
                conversationId: continuation.conversationId,
                runtimeKey: runtime.key,
                identities: completed.durableInputIdentities,
                revision: completed.revision,
                authorityRevision: completedSnapshot?.revisionToken,
                recoveryLineageId,
              })
            ) {
              await recoveryClaim?.release();
              scheduleRecordedTurnRecovery(listener, () =>
                recoverRecordedTurns(listener, deps),
              );
              return;
            }
            const pendingCompletion = markRecoveryClaimCompletionPending(
              store,
              completed,
              completedSnapshot?.revisionToken,
            );
            if (!pendingCompletion) {
              await recoveryClaim?.release();
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
