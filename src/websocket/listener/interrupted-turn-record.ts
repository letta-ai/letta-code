import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ApprovalResult } from "@/agent/approval-execution";
import { reportListenerStateWriteFailure } from "@/telemetry/error-reporting";
import { debugWarn } from "@/utils/debug";
import { acquireDurableFileLock } from "./durable-file-lock";
import {
  collectInterruptedTurnInputOwnershipWithSidecars,
  listInterruptedTurnMainSnapshot as snapshotMain,
} from "./interrupted-turn-input-ownership";
import { isInterruptedTurnRecord } from "./interrupted-turn-schema";
import {
  defaultInterruptedTurnDirectory,
  fsyncInterruptedTurnDirectory,
  writeInterruptedTurnRecordFile,
} from "./interrupted-turn-storage";
import type { InterruptedTurnRecord } from "./interrupted-turn-types";
import { allRecordedResults } from "./recorded-tool-results";
import {
  createRecoveryLineageSidecarAccess,
  type RecoveryLineageSidecar,
} from "./recovery-lineage-sidecar";
import type { ConversationRuntime } from "./types";

export type { InterruptedTurnRecord } from "./interrupted-turn-types";
export {
  allRecordedResults,
  recordedToolResults,
} from "./recorded-tool-results";

export type ListenerStateWritePhase =
  | "run_observed"
  | "before_tool_execution"
  | "after_tool_execution";
export function createInterruptedTurnStore(
  directory = defaultInterruptedTurnDirectory(),
  dependencies: {
    fsyncDirectory?: (directory: string) => void;
    lockWaitMs?: number;
  } = {},
) {
  const sync = dependencies.fsyncDirectory ?? fsyncInterruptedTurnDirectory;
  function persist(destination: string, record: InterruptedTurnRecord) {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      writeInterruptedTurnRecordFile(
        temporary,
        destination,
        directory,
        record,
        sync,
      );
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  function path(agentId: string, conversationId: string) {
    return join(
      directory,
      `${encodeURIComponent(agentId)}_${encodeURIComponent(conversationId)}.json`,
    );
  }
  function readRecord(file: string): InterruptedTurnRecord | null {
    try {
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isInterruptedTurnRecord(value, file, path)) {
        throw new Error("Invalid interrupted-turn record");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        debugWarn(
          "recovery",
          "Ignoring unreadable interrupted-turn record",
          file,
          error,
        );
      }
      return null;
    }
  }
  const {
    compactRetired: compactRetiredSidecar,
    compactRetiredReference: compactRetiredSidecarReference,
    initial: initialSidecar,
    list: listSidecars,
    mainView: readMainView,
    read: readSidecar,
    retire: retireSidecar,
    retiredAuthority: readRetiredRecoveryAuthority,
    recoveryView: readRecoveryView,
    remove: removeSidecar,
    removeRetired: removeRetiredSidecar,
    snapshot: snapshotSidecar,
    write: writeSidecar,
  } = createRecoveryLineageSidecarAccess({
    directory,
    syncDirectory: sync,
    lockWaitMs: dependencies.lockWaitMs,
  });
  const rawSnapshot = () => snapshotMain(directory, readRecord);
  return {
    list(): InterruptedTurnRecord[] {
      try {
        const rawRecords = rawSnapshot().records;
        const liveLineages = new Set(
          rawRecords.flatMap((record) => {
            const lineageId = record.recoveryClaimCompletion?.lineageId;
            return lineageId
              ? [`${record.agentId}\0${record.conversationId}\0${lineageId}`]
              : [];
          }),
        );
        for (const sidecar of listSidecars()) {
          if (sidecar.state === "retired") {
            continue;
          }
          const key = `${sidecar.agentId}\0${sidecar.conversationId}\0${sidecar.lineageId}`;
          if (liveLineages.has(key)) continue;
          const destination = path(sidecar.agentId, sidecar.conversationId);
          const release = acquireDurableFileLock(destination, {
            waitMs: dependencies.lockWaitMs,
          });
          try {
            const current = readRecord(destination);
            if (!existsSync(destination)) {
              removeSidecar(sidecar);
            } else if (
              current &&
              current.recoveryClaimCompletion?.lineageId !== sidecar.lineageId
            ) {
              removeSidecar(sidecar);
            }
          } finally {
            release();
          }
        }
        return rawRecords.flatMap((record) => {
          try {
            return [readMainView(record)];
          } catch (error) {
            debugWarn(
              "recovery",
              "Ignoring interrupted-turn record with unreadable lineage sidecar",
              record.agentId,
              record.conversationId,
              error,
            );
            return [];
          }
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    listDurableInputOwnership() {
      const snapshot = rawSnapshot();
      return collectInterruptedTurnInputOwnershipWithSidecars(
        snapshot.records,
        readMainView,
        listSidecars(),
        (agentId, conversationId) => existsSync(path(agentId, conversationId)),
        snapshot.unreadableScopes,
      );
    },
    read(
      agentId: string,
      conversationId: string,
    ): InterruptedTurnRecord | null {
      const current = readRecord(path(agentId, conversationId));
      return current ? readMainView(current) : null;
    },
    readRecoveryView(
      agentId: string,
      conversationId: string,
      lineageId: string,
    ): InterruptedTurnRecord | null {
      const current = readRecord(path(agentId, conversationId));
      if (current?.recoveryClaimCompletion?.lineageId !== lineageId)
        return null;
      return readRecoveryView(current);
    },
    readRecoverySnapshot(
      agentId: string,
      conversationId: string,
      lineageId: string,
    ): {
      record: InterruptedTurnRecord;
      revisionToken: string;
    } | null {
      const destination = path(agentId, conversationId);
      const release = acquireDurableFileLock(destination, {
        waitMs: dependencies.lockWaitMs,
      });
      try {
        const current = readRecord(destination);
        if (!current && existsSync(destination)) {
          throw new Error("Interrupted-turn authority is unreadable");
        }
        if (current?.recoveryClaimCompletion?.lineageId !== lineageId)
          return null;
        if (current.recoveryClaimCompletion.independentSuccessor !== true)
          return current.revision
            ? { record: current, revisionToken: current.revision }
            : null;
        if (!readSidecar(agentId, conversationId, lineageId)) {
          writeSidecar(initialSidecar(current));
        }
        return snapshotSidecar(current);
      } finally {
        release();
      }
    },
    readRetiredRecoveryAuthority,
    listRecoverySidecars: listSidecars,
    compactRetiredRecoverySidecar(sidecar: RecoveryLineageSidecar) {
      let compacted = false;
      removeRetiredSidecar(sidecar, () => {
        compactRetiredSidecarReference(sidecar);
        compacted = true;
        return false;
      });
      return compacted;
    },
    removeRetiredRecoverySidecar(sidecar: RecoveryLineageSidecar) {
      return removeRetiredSidecar(sidecar, () => {
        const destination = path(sidecar.agentId, sidecar.conversationId);
        const current = readRecord(destination);
        if (current?.recoveryClaimCompletion?.lineageId === sidecar.lineageId) {
          return false;
        }
        compactRetiredSidecar(sidecar);
        return true;
      });
    },
    write(
      record: InterruptedTurnRecord,
      expectedRevision?: string | null,
    ): InterruptedTurnRecord {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const destination = path(record.agentId, record.conversationId);
      const release = acquireDurableFileLock(destination, {
        waitMs: dependencies.lockWaitMs,
      });
      try {
        const current = readRecord(destination);
        const retiredSidecar =
          current?.recoveryClaimCompletion?.independentSuccessor === true
            ? readSidecar(
                current.agentId,
                current.conversationId,
                current.recoveryClaimCompletion.lineageId,
              )
            : null;
        if (
          retiredSidecar?.state === "retired" &&
          record.recoveryClaimCompletion?.lineageId === retiredSidecar.lineageId
        ) {
          throw new Error("Recovery lineage retired");
        }
        if (!current && record.revision) {
          throw new Error("Interrupted-turn revision cannot recreate a record");
        }
        if (
          expectedRevision !== undefined &&
          (current?.revision ?? null) !== expectedRevision
        ) {
          throw new Error("Interrupted-turn revision changed");
        }
        const revision = randomUUID();
        const written = {
          ...record,
          revision,
          ...(record.teleport
            ? {
                teleport: {
                  ...record.teleport,
                  intentRevision: record.teleport.intentRevision ?? revision,
                  readyRevision: record.teleport.ready
                    ? (record.teleport.readyRevision ?? revision)
                    : record.teleport.readyRevision,
                },
              }
            : {}),
        };
        persist(destination, written);
        return written;
      } finally {
        release();
      }
    },
    writeRecoveryLineageSnapshot(params: {
      agentId: string;
      conversationId: string;
      lineageId: string;
      update: Partial<
        Pick<
          InterruptedTurnRecord,
          | "runId"
          | "toolCallIds"
          | "unstartedToolCallIds"
          | "results"
          | "requestOtid"
          | "actingUserId"
          | "durableInputIdentities"
          | "terminalConsumerIds"
          | "teleport"
        >
      >;
      expectedSidecarRevision?: string;
    }): { mainRevision: string; sidecarRevision: string } {
      const destination = path(params.agentId, params.conversationId);
      const release = acquireDurableFileLock(destination, {
        waitMs: dependencies.lockWaitMs,
      });
      try {
        const current = readRecord(destination);
        const marker = current?.recoveryClaimCompletion;
        if (
          !current?.revision ||
          marker?.lineageId !== params.lineageId ||
          !marker.independentSuccessor
        ) {
          throw new Error("Independent recovery lineage changed");
        }
        const previous =
          readSidecar(
            params.agentId,
            params.conversationId,
            params.lineageId,
          ) ?? initialSidecar(current);
        if (previous.state !== "running") {
          throw new Error("Recovery lineage is not running");
        }
        if (
          params.expectedSidecarRevision !== undefined &&
          previous.revision !== params.expectedSidecarRevision
        ) {
          throw new Error("Recovery lineage revision changed");
        }
        const toolCallIds = params.update.toolCallIds
          ? [
              ...new Set([
                ...previous.toolCallIds,
                ...params.update.toolCallIds,
              ]),
            ]
          : previous.toolCallIds;
        const results = params.update.results
          ? [...params.update.results]
          : previous.results;
        const exactResultIds = new Set(
          (previous.exactResults ?? []).map((result) => result.tool_call_id),
        );
        const written: RecoveryLineageSidecar = {
          ...previous,
          revision: randomUUID(),
          toolCallIds,
          results,
          ...(params.update.runId !== undefined
            ? { runId: params.update.runId }
            : {}),
          ...(Object.hasOwn(params.update, "unstartedToolCallIds")
            ? {
                unstartedToolCallIds:
                  params.update.unstartedToolCallIds === undefined
                    ? undefined
                    : params.update.unstartedToolCallIds.filter(
                        (toolCallId) => !exactResultIds.has(toolCallId),
                      ),
              }
            : {}),
          ...(params.update.requestOtid
            ? { requestOtid: params.update.requestOtid }
            : {}),
          ...(Object.hasOwn(params.update, "actingUserId")
            ? { actingUserId: params.update.actingUserId }
            : {}),
          ...(params.update.durableInputIdentities
            ? {
                durableInputIdentities: [
                  ...params.update.durableInputIdentities,
                ],
              }
            : {}),
          ...(params.update.terminalConsumerIds
            ? {
                terminalConsumerIds: [...params.update.terminalConsumerIds],
              }
            : {}),
          ...(Object.hasOwn(params.update, "teleport")
            ? { teleport: params.update.teleport }
            : {}),
        };
        writeSidecar(written);
        return {
          mainRevision: current.revision,
          sidecarRevision: written.revision,
        };
      } finally {
        release();
      }
    },
    mergeSettledRecoveryResult(params: {
      agentId: string;
      conversationId: string;
      lineageId: string;
      result: ApprovalResult;
    }): { revision: string; independentSuccessor: boolean } {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const destination = path(params.agentId, params.conversationId);
      const release = acquireDurableFileLock(destination, {
        waitMs: dependencies.lockWaitMs,
      });
      try {
        const current = readRecord(destination);
        const marker = current?.recoveryClaimCompletion;
        if (!current || marker?.lineageId !== params.lineageId) {
          throw new Error(
            "Recovery lineage changed before exact result commit",
          );
        }
        if (marker.independentSuccessor) {
          if (!current.revision) {
            throw new Error("Independent successor has no durable revision");
          }
          const previous =
            readSidecar(
              params.agentId,
              params.conversationId,
              params.lineageId,
            ) ?? initialSidecar(current);
          if (previous.state !== "running") {
            throw new Error("Recovery lineage is not running");
          }
          const exactResults = [...(previous.exactResults ?? [])];
          const resultIndex = exactResults.findIndex(
            (result) => result.tool_call_id === params.result.tool_call_id,
          );
          if (resultIndex >= 0) exactResults[resultIndex] = params.result;
          else exactResults.push(params.result);
          writeSidecar({
            ...previous,
            revision: randomUUID(),
            exactResults,
            unstartedToolCallIds: previous.unstartedToolCallIds?.filter(
              (toolCallId) => toolCallId !== params.result.tool_call_id,
            ),
          });
          return { revision: current.revision, independentSuccessor: true };
        }
        const revision = randomUUID();
        const written: InterruptedTurnRecord = {
          ...current,
          revision,
          results: marker.independentSuccessor
            ? current.results
            : [
                ...current.results.filter(
                  (result) =>
                    result.tool_call_id !== params.result.tool_call_id,
                ),
                params.result,
              ],
          settledRecoveryEffects: [
            ...(current.settledRecoveryEffects ?? []).filter(
              (effect) =>
                effect.lineageId !== params.lineageId ||
                effect.result.tool_call_id !== params.result.tool_call_id,
            ),
            { lineageId: params.lineageId, result: params.result },
          ],
          unstartedToolCallIds: marker.independentSuccessor
            ? current.unstartedToolCallIds
            : current.unstartedToolCallIds?.filter(
                (toolCallId) => toolCallId !== params.result.tool_call_id,
              ),
        };
        persist(destination, written);
        return {
          revision,
          independentSuccessor: false,
        };
      } finally {
        release();
      }
    },
    markRecoveryClaimCompletionPending(params: {
      agentId: string;
      conversationId: string;
      lineageId: string;
      expectedRevision: string;
    }): InterruptedTurnRecord | null {
      const destination = path(params.agentId, params.conversationId);
      const release = acquireDurableFileLock(destination, {
        waitMs: dependencies.lockWaitMs,
      });
      try {
        const current = readRecord(destination);
        const marker = current?.recoveryClaimCompletion;
        if (
          !current?.revision ||
          !marker ||
          marker.lineageId !== params.lineageId
        ) {
          return null;
        }
        if (marker.independentSuccessor) {
          const previous =
            readSidecar(
              params.agentId,
              params.conversationId,
              params.lineageId,
            ) ?? initialSidecar(current);
          if (
            previous.state === "retired" ||
            previous.revision !== params.expectedRevision
          )
            return null;
          const pending =
            previous.state === "pending"
              ? previous
              : {
                  ...previous,
                  pendingAuthorityRevision: previous.revision,
                  revision: randomUUID(),
                  state: "pending" as const,
                };
          if (pending !== previous) writeSidecar(pending);
          const view = readRecoveryView(current);
          return view ? { ...view, revision: pending.revision } : null;
        }
        if (current.revision !== params.expectedRevision) return null;
        if (marker.state === "pending") return current;
        const written: InterruptedTurnRecord = {
          ...current,
          revision: randomUUID(),
          recoveryClaimCompletion: {
            ...marker,
            state: "pending",
            effectRevision: current.revision,
          },
        };
        persist(destination, written);
        return written;
      } finally {
        release();
      }
    },
    retireRecoveryClaimCompletion(params: {
      agentId: string;
      conversationId: string;
      lineageId: string;
      pendingRevision: string;
    }): "removed" | "preserved" | "stale" {
      const destination = path(params.agentId, params.conversationId);
      const release = acquireDurableFileLock(destination, {
        waitMs: dependencies.lockWaitMs,
      });
      try {
        const current = readRecord(destination);
        const marker = current?.recoveryClaimCompletion;
        if (!current || !marker || marker.lineageId !== params.lineageId) {
          return "stale";
        }
        if (marker.independentSuccessor) {
          const existing = readSidecar(
            params.agentId,
            params.conversationId,
            params.lineageId,
          );
          const previous = existing ?? initialSidecar(current);
          if (
            previous.state !== "pending" ||
            (existing !== null &&
              previous.revision !== params.pendingRevision &&
              current.revision !== params.pendingRevision)
          ) {
            if (previous.state === "retired") return "stale";
            throw new Error("Recovery lineage pending revision changed");
          }
          retireSidecar(current, previous);
          return "preserved";
        }
        if (
          current.revision === params.pendingRevision &&
          !marker.independentSuccessor
        ) {
          const retiredAuthority = retireSidecar(current);
          const evidence = readFileSync(destination, "utf8");
          unlinkSync(destination);
          try {
            sync(directory);
          } catch (error) {
            try {
              writeFileSync(destination, evidence, {
                mode: 0o600,
                flush: true,
              });
              sync(directory);
            } catch {}
            try {
              removeSidecar(retiredAuthority);
            } catch {}
            throw error;
          }
          return "removed";
        }
        if (!current.revision || !marker.independentSuccessor) return "stale";
        const retiredEffects = (current.settledRecoveryEffects ?? []).filter(
          (effect) => effect.lineageId === params.lineageId,
        );
        const retiredToolCallIds = new Set([
          ...(marker.effectToolCallIds ?? []),
          ...retiredEffects.map((effect) => effect.result.tool_call_id),
        ]);
        const preserved: InterruptedTurnRecord = {
          ...current,
          revision: randomUUID(),
          recoveryClaimCompletion: undefined,
          toolCallIds: current.toolCallIds.filter(
            (toolCallId) => !retiredToolCallIds.has(toolCallId),
          ),
          results: current.results.filter(
            (result) => !retiredToolCallIds.has(result.tool_call_id),
          ),
          unstartedToolCallIds: current.unstartedToolCallIds?.filter(
            (toolCallId) => !retiredToolCallIds.has(toolCallId),
          ),
          settledRecoveryEffects: current.settledRecoveryEffects?.filter(
            (effect) => effect.lineageId !== params.lineageId,
          ),
        };
        persist(destination, preserved);
        return "preserved";
      } finally {
        release();
      }
    },
    remove(
      agentId: string,
      conversationId: string,
      expectedRevision?: string | null,
    ): boolean {
      const destination = path(agentId, conversationId);
      const release = acquireDurableFileLock(destination, {
        waitMs: dependencies.lockWaitMs,
      });
      try {
        let evidence: string;
        try {
          const current = readRecord(destination);
          if (!current) return expectedRevision === undefined;
          if (
            expectedRevision !== undefined &&
            (current.revision ?? null) !== expectedRevision
          ) {
            return false;
          }
          evidence = readFileSync(destination, "utf8");
          unlinkSync(destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
          throw error;
        }
        try {
          sync(directory);
        } catch (error) {
          try {
            writeFileSync(destination, evidence, { mode: 0o600, flush: true });
            sync(directory);
          } catch {}
          throw error;
        }
        return true;
      } finally {
        release();
      }
    },
  };
}
export function recordListenerWork(
  runtime: ConversationRuntime,
  update: Partial<
    Pick<
      InterruptedTurnRecord,
      | "runId"
      | "toolCallIds"
      | "unstartedToolCallIds"
      | "results"
      | "requestOtid"
      | "actingUserId"
      | "recoveryClaimCompletion"
      | "durableInputIdentities"
      | "terminalConsumerIds"
      | "teleport"
    >
  >,
  phase: ListenerStateWritePhase,
  expectedRevision?: string | null,
  recoveryLineageId?: string,
  store = createInterruptedTurnStore(),
): string | undefined {
  if (!runtime.agentId || !runtime.listener.connectionId?.startsWith("conn-"))
    return undefined;
  const previous = store.read(runtime.agentId, runtime.conversationId);
  const sameRecoveryLineage =
    previous?.recoveryClaimCompletion !== undefined &&
    recoveryLineageId === previous.recoveryClaimCompletion.lineageId;
  const inheritedCompletion = previous?.recoveryClaimCompletion
    ? sameRecoveryLineage
      ? {
          ...previous.recoveryClaimCompletion,
          effectToolCallIds: update.toolCallIds
            ? [
                ...new Set([
                  ...(previous.recoveryClaimCompletion.effectToolCallIds ??
                    previous.toolCallIds),
                  ...update.toolCallIds,
                ]),
              ]
            : previous.recoveryClaimCompletion.effectToolCallIds,
          effectRunId:
            update.runId !== undefined
              ? update.runId
              : previous.recoveryClaimCompletion.effectRunId,
          effectRequestOtid:
            update.requestOtid ??
            previous.recoveryClaimCompletion.effectRequestOtid,
          effectResults:
            update.results ?? previous.recoveryClaimCompletion.effectResults,
          effectUnstartedToolCallIds: Object.hasOwn(
            update,
            "unstartedToolCallIds",
          )
            ? update.unstartedToolCallIds
            : previous.recoveryClaimCompletion.effectUnstartedToolCallIds,
          effectInputIdentities:
            update.durableInputIdentities ??
            previous.recoveryClaimCompletion.effectInputIdentities,
          effectActingUserId: Object.hasOwn(update, "actingUserId")
            ? (update.actingUserId ?? null)
            : previous.recoveryClaimCompletion.effectActingUserId,
          effectTerminalConsumerIds:
            update.terminalConsumerIds ??
            previous.recoveryClaimCompletion.effectTerminalConsumerIds,
          effectTeleport: Object.hasOwn(update, "teleport")
            ? update.teleport
            : previous.recoveryClaimCompletion.effectTeleport,
        }
      : {
          ...previous.recoveryClaimCompletion,
          independentSuccessor: true,
          effectRevision:
            previous.recoveryClaimCompletion.effectRevision ??
            previous.revision,
          effectInputIdentities:
            previous.recoveryClaimCompletion.effectInputIdentities ??
            previous.durableInputIdentities ??
            [],
          effectToolCallIds:
            previous.recoveryClaimCompletion.effectToolCallIds ??
            previous.toolCallIds,
          effectRunId:
            previous.recoveryClaimCompletion.effectRunId !== undefined
              ? previous.recoveryClaimCompletion.effectRunId
              : previous.runId,
          effectRequestOtid:
            previous.recoveryClaimCompletion.effectRequestOtid ??
            previous.requestOtid,
          effectWorkingDirectory:
            previous.recoveryClaimCompletion.effectWorkingDirectory ??
            previous.workingDirectory,
          effectActingUserId:
            previous.recoveryClaimCompletion.effectActingUserId !== undefined
              ? previous.recoveryClaimCompletion.effectActingUserId
              : (previous.actingUserId ?? null),
          effectResults:
            previous.recoveryClaimCompletion.effectResults ??
            allRecordedResults(previous),
          effectUnstartedToolCallIds:
            previous.recoveryClaimCompletion.effectUnstartedToolCallIds ??
            previous.unstartedToolCallIds ??
            [],
          effectTerminalConsumerIds:
            previous.recoveryClaimCompletion.effectTerminalConsumerIds ??
            previous.terminalConsumerIds ??
            [],
          effectTeleport:
            previous.recoveryClaimCompletion.effectTeleport ??
            previous.teleport,
        }
    : undefined;
  const consumesInheritedTeleport =
    previous?.teleport !== undefined &&
    update.durableInputIdentities?.some(
      (identity) =>
        identity.domain === "teleport" &&
        identity.id === previous.teleport?.teleportId,
    );
  const record: InterruptedTurnRecord = {
    revision: previous?.revision,
    agentId: runtime.agentId,
    conversationId: runtime.conversationId,
    runId: previous?.runId ?? null,
    toolCallIds: previous?.toolCallIds ?? [],
    unstartedToolCallIds: previous?.unstartedToolCallIds,
    results: previous?.results ?? [],
    settledRecoveryEffects: previous?.settledRecoveryEffects,
    requestOtid: previous?.requestOtid ?? randomUUID(),
    actingUserId: previous?.actingUserId,
    recoveryClaimCompletion: inheritedCompletion,
    durableInputIdentities: previous?.durableInputIdentities,
    terminalConsumerIds: previous?.terminalConsumerIds,
    teleport: consumesInheritedTeleport ? undefined : previous?.teleport,
    workingDirectory:
      runtime.activeWorkingDirectory ??
      previous?.workingDirectory ??
      process.cwd(),
    ...update,
  };
  try {
    const independentRecoveryWrite =
      sameRecoveryLineage &&
      previous?.recoveryClaimCompletion?.independentSuccessor === true;
    const written = independentRecoveryWrite
      ? store.writeRecoveryLineageSnapshot({
          agentId: record.agentId,
          conversationId: record.conversationId,
          lineageId: recoveryLineageId as string,
          update,
          expectedSidecarRevision: expectedRevision ?? undefined,
        })
      : store.write(
          record,
          expectedRevision === undefined
            ? (previous?.revision ?? null)
            : expectedRevision,
        );
    const durableInputIdentities = independentRecoveryWrite
      ? (update.durableInputIdentities ??
        previous?.recoveryClaimCompletion?.effectInputIdentities ??
        [])
      : ((written as InterruptedTurnRecord).durableInputIdentities ?? []);
    const durableIdentityKeys = new Set(
      durableInputIdentities.map(
        (identity) => `${identity.domain}:${identity.id}`,
      ),
    );
    for (const [
      batchId,
      identities,
    ] of runtime.dequeuedInputIdentitiesByBatchId) {
      if (
        identities.length > 0 &&
        identities.every((identity) =>
          durableIdentityKeys.has(`${identity.domain}:${identity.id}`),
        )
      ) {
        runtime.dequeuedInputIdentitiesByBatchId.delete(batchId);
      }
    }
    return independentRecoveryWrite
      ? (written as { sidecarRevision: string }).sidecarRevision
      : (written as InterruptedTurnRecord).revision;
  } catch (error) {
    reportListenerStateWriteFailure({
      phase,
      error,
      agentId: record.agentId,
      conversationId: record.conversationId,
      runId: record.runId ?? runtime.activeRunId ?? undefined,
      toolCallId: record.toolCallIds[0],
    });
    throw error;
  }
}

export async function recordListenerWorkRetriably(
  runtime: ConversationRuntime,
  update: Parameters<typeof recordListenerWork>[1],
  phase: ListenerStateWritePhase,
  expectedRevision?: string | null,
  recoveryLineageId?: string,
  options: {
    shouldContinue?: () => boolean;
    retryDelayMs?: number;
    lockWaitMs?: number;
    store?: ReturnType<typeof createInterruptedTurnStore>;
  } = {},
): Promise<string | undefined> {
  const store =
    options.store ??
    createInterruptedTurnStore(defaultInterruptedTurnDirectory(), {
      lockWaitMs: options.lockWaitMs ?? 25,
    });
  let retryExpectedRevision = expectedRevision;
  while (options.shouldContinue?.() !== false) {
    try {
      return recordListenerWork(
        runtime,
        update,
        phase,
        retryExpectedRevision,
        recoveryLineageId,
        store,
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (
        error.message === "Interrupted-turn revision changed" ||
        error.message === "Recovery lineage revision changed" ||
        (phase === "run_observed" &&
          error.message ===
            "Interrupted-turn revision cannot recreate a record")
      ) {
        if (!runtime.agentId) throw error;
        const current = store.read(runtime.agentId, runtime.conversationId);
        if (recoveryLineageId) {
          if (
            current?.recoveryClaimCompletion?.lineageId !== recoveryLineageId
          ) {
            throw error;
          }
          retryExpectedRevision =
            store.readRecoverySnapshot(
              runtime.agentId,
              runtime.conversationId,
              recoveryLineageId,
            )?.revisionToken ?? null;
        } else if (phase !== "run_observed") {
          throw error;
        } else {
          retryExpectedRevision = current?.revision ?? null;
        }
      } else if (
        error.message !== "Timed out acquiring durable filesystem lock"
      ) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.retryDelayMs ?? 10);
        timer.unref?.();
      });
    }
  }
  throw new Error("Interrupted durable write lost authority before commit");
}

export function forgetListenerWork(
  runtime: ConversationRuntime,
  expectedRevision?: string | null,
): void {
  if (runtime.agentId && runtime.listener.connectionId?.startsWith("conn-")) {
    const store = createInterruptedTurnStore();
    if (expectedRevision !== undefined) {
      const current = store.read(runtime.agentId, runtime.conversationId);
      if (
        current &&
        (current?.revision ?? null) === expectedRevision &&
        (current.teleport || current.teleportId)
      ) {
        return;
      }
      store.remove(runtime.agentId, runtime.conversationId, expectedRevision);
    }
  }
}
