import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApprovalResult } from "@/agent/approval-execution";
import { STALE_APPROVAL_RECOVERY_DENIAL_REASON } from "@/agent/turn-recovery-policy";
import { getServerUrl } from "@/backend/api/server-url";
import { reportListenerStateWriteFailure } from "@/telemetry/error-reporting";
import type { TeleportContinuation } from "@/types/protocol_v2";
import { isTerminalConsumerId } from "@/types/turn-finished-protocol";
import { debugWarn } from "@/utils/debug";
import { acquireDurableFileLock } from "./durable-file-lock";
import { isTeleportContinuation } from "./teleport-protocol-inbound";
import type { ConversationRuntime, InputIdentity } from "./types";

export type ListenerStateWritePhase =
  | "run_observed"
  | "before_tool_execution"
  | "after_tool_execution";

/** Local execution evidence, never populated by observing another runtime. */
export interface InterruptedTurnRecord {
  revision?: string;
  teleportId?: string;
  teleport?: {
    teleportId: string;
    connectionId: string;
    connectionGeneration?: string;
    activeTurn: boolean;
    continuation?: TeleportContinuation;
    ready: boolean;
    /** Revision created when this exact intent was first journaled. */
    intentRevision?: string;
    /** Interrupted-record revision captured by the durable terminal owner. */
    committedRevision?: string;
  };
  actingUserId?: string;
  recoveryClaimCompletion?: {
    lineageId: string;
    state: "running" | "pending";
    /** Exact predecessor revision whose completed effects this marker covers. */
    effectRevision?: string;
    /** Input identities owned by that predecessor, retained across a successor write. */
    effectInputIdentities?: InputIdentity[];
    /** Complete tool namespace owned by that predecessor recovery lineage. */
    effectToolCallIds?: string[];
    /** A write outside this recovery lineage has added genuine successor work. */
    independentSuccessor?: boolean;
  };
  agentId: string;
  conversationId: string;
  runId: string | null;
  toolCallIds: string[];
  /** Approved tools which have not crossed their own execution boundary. */
  unstartedToolCallIds?: string[];
  results: ApprovalResult[];
  /** Exact settled effects that survive an independent successor snapshot. */
  settledRecoveryEffects?: Array<{
    lineageId: string;
    result: ApprovalResult;
  }>;
  requestOtid: string;
  workingDirectory: string;
  durableInputIdentities?: InputIdentity[];
  terminalConsumerIds?: string[];
}

function fsyncDirectory(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): void {
  // Windows cannot open directories. The temp file itself is still flushed by
  // writeFileSync, while POSIX additionally commits directory entry changes.
  if (platform === "win32") return;
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function defaultInterruptedTurnDirectory(): string {
  let serverUrl: string;
  try {
    serverUrl = getServerUrl();
  } catch {
    serverUrl = process.env.LETTA_BASE_URL ?? "uninitialized";
  }
  return join(
    homedir(),
    ".letta",
    "listener-state",
    createHash("sha256").update(serverUrl).digest("hex").slice(0, 24),
  );
}

export function createInterruptedTurnStore(
  directory = defaultInterruptedTurnDirectory(),
  dependencies: {
    fsyncDirectory?: (directory: string) => void;
    lockWaitMs?: number;
  } = {},
) {
  const syncDirectory = dependencies.fsyncDirectory ?? fsyncDirectory;
  function path(agentId: string, conversationId: string) {
    return join(
      directory,
      `${encodeURIComponent(agentId)}_${encodeURIComponent(conversationId)}.json`,
    );
  }
  function readRecord(file: string): InterruptedTurnRecord | null {
    try {
      const value = JSON.parse(
        readFileSync(file, "utf8"),
      ) as InterruptedTurnRecord;
      if (
        !value ||
        typeof value.agentId !== "string" ||
        typeof value.conversationId !== "string" ||
        path(value.agentId, value.conversationId) !== file ||
        !Array.isArray(value.toolCallIds) ||
        !value.toolCallIds.every((id) => typeof id === "string") ||
        (value.unstartedToolCallIds !== undefined &&
          (!Array.isArray(value.unstartedToolCallIds) ||
            !value.unstartedToolCallIds.every(
              (id) => typeof id === "string",
            ))) ||
        !Array.isArray(value.results) ||
        !value.results.every(
          (result) => result && typeof result.tool_call_id === "string",
        ) ||
        (value.settledRecoveryEffects !== undefined &&
          (!Array.isArray(value.settledRecoveryEffects) ||
            !value.settledRecoveryEffects.every(
              (effect) =>
                effect &&
                typeof effect.lineageId === "string" &&
                effect.lineageId.length > 0 &&
                effect.result &&
                typeof effect.result.tool_call_id === "string",
            ))) ||
        (value.durableInputIdentities !== undefined &&
          (!Array.isArray(value.durableInputIdentities) ||
            !value.durableInputIdentities.every(
              (identity) =>
                identity &&
                (identity.domain === "input" ||
                  identity.domain === "teleport") &&
                typeof identity.id === "string" &&
                identity.id.length > 0,
            ))) ||
        (value.terminalConsumerIds !== undefined &&
          (!Array.isArray(value.terminalConsumerIds) ||
            !value.terminalConsumerIds.every(isTerminalConsumerId))) ||
        (value.actingUserId !== undefined &&
          typeof value.actingUserId !== "string") ||
        (value.recoveryClaimCompletion !== undefined &&
          (!value.recoveryClaimCompletion ||
            typeof value.recoveryClaimCompletion.lineageId !== "string" ||
            value.recoveryClaimCompletion.lineageId.length === 0 ||
            (value.recoveryClaimCompletion.state !== "running" &&
              value.recoveryClaimCompletion.state !== "pending") ||
            (value.recoveryClaimCompletion.effectRevision !== undefined &&
              typeof value.recoveryClaimCompletion.effectRevision !==
                "string") ||
            (value.recoveryClaimCompletion.effectInputIdentities !==
              undefined &&
              (!Array.isArray(
                value.recoveryClaimCompletion.effectInputIdentities,
              ) ||
                !value.recoveryClaimCompletion.effectInputIdentities.every(
                  (identity) =>
                    identity &&
                    (identity.domain === "input" ||
                      identity.domain === "teleport") &&
                    typeof identity.id === "string" &&
                    identity.id.length > 0,
                ))) ||
            (value.recoveryClaimCompletion.effectToolCallIds !== undefined &&
              (!Array.isArray(
                value.recoveryClaimCompletion.effectToolCallIds,
              ) ||
                !value.recoveryClaimCompletion.effectToolCallIds.every(
                  (toolCallId) =>
                    typeof toolCallId === "string" && toolCallId.length > 0,
                ))) ||
            (value.recoveryClaimCompletion.independentSuccessor !== undefined &&
              typeof value.recoveryClaimCompletion.independentSuccessor !==
                "boolean") ||
            (value.recoveryClaimCompletion.state === "pending" &&
              !value.recoveryClaimCompletion.effectRevision))) ||
        (value.teleport !== undefined &&
          (!value.teleport ||
            typeof value.teleport.teleportId !== "string" ||
            typeof value.teleport.connectionId !== "string" ||
            (value.teleport.connectionGeneration !== undefined &&
              typeof value.teleport.connectionGeneration !== "string") ||
            typeof value.teleport.activeTurn !== "boolean" ||
            typeof value.teleport.ready !== "boolean" ||
            (value.teleport.intentRevision !== undefined &&
              typeof value.teleport.intentRevision !== "string") ||
            (value.teleport.committedRevision !== undefined &&
              typeof value.teleport.committedRevision !== "string") ||
            (value.teleport.continuation !== undefined &&
              !isTeleportContinuation(value.teleport.continuation)))) ||
        typeof value.requestOtid !== "string" ||
        typeof value.workingDirectory !== "string"
      ) {
        throw new Error("Invalid interrupted-turn record");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        debugWarn(
          "recovery",
          "Ignoring unreadable interrupted-turn record",
          file,
        );
      }
      return null;
    }
  }
  return {
    list(): InterruptedTurnRecord[] {
      try {
        return readdirSync(directory)
          .filter((file) => file.endsWith(".json"))
          .map((file) => readRecord(join(directory, file)))
          .filter((record): record is InterruptedTurnRecord => record !== null);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    read(
      agentId: string,
      conversationId: string,
    ): InterruptedTurnRecord | null {
      return readRecord(path(agentId, conversationId));
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
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        const current = readRecord(destination);
        // A revision-bearing record is a full snapshot of existing durable
        // state, never a creation intent. Once the current file is absent, no
        // stale owner may recreate it, regardless of its expected revision.
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
          ...(record.teleport && !record.teleport.intentRevision
            ? { teleport: { ...record.teleport, intentRevision: revision } }
            : {}),
        };
        writeFileSync(temporary, JSON.stringify(written), {
          mode: 0o600,
          flush: true,
        });
        renameSync(temporary, destination);
        syncDirectory(directory);
        return written;
      } finally {
        rmSync(temporary, { force: true });
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
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        const current = readRecord(destination);
        const marker = current?.recoveryClaimCompletion;
        if (!current || marker?.lineageId !== params.lineageId) {
          throw new Error(
            "Recovery lineage changed before exact result commit",
          );
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
        writeFileSync(temporary, JSON.stringify(written), {
          mode: 0o600,
          flush: true,
        });
        renameSync(temporary, destination);
        syncDirectory(directory);
        return {
          revision,
          independentSuccessor: marker.independentSuccessor === true,
        };
      } finally {
        rmSync(temporary, { force: true });
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
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        const current = readRecord(destination);
        const marker = current?.recoveryClaimCompletion;
        if (
          !current?.revision ||
          current.revision !== params.expectedRevision ||
          !marker ||
          marker.lineageId !== params.lineageId
        ) {
          return null;
        }
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
        writeFileSync(temporary, JSON.stringify(written), {
          mode: 0o600,
          flush: true,
        });
        renameSync(temporary, destination);
        syncDirectory(directory);
        return written;
      } finally {
        rmSync(temporary, { force: true });
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
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        const current = readRecord(destination);
        const marker = current?.recoveryClaimCompletion;
        if (!current || !marker || marker.lineageId !== params.lineageId) {
          return "stale";
        }
        if (
          current.revision === params.pendingRevision &&
          !marker.independentSuccessor
        ) {
          const evidence = readFileSync(destination, "utf8");
          unlinkSync(destination);
          try {
            syncDirectory(directory);
          } catch (error) {
            try {
              writeFileSync(destination, evidence, {
                mode: 0o600,
                flush: true,
              });
              syncDirectory(directory);
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
        writeFileSync(temporary, JSON.stringify(preserved), {
          mode: 0o600,
          flush: true,
        });
        renameSync(temporary, destination);
        syncDirectory(directory);
        return "preserved";
      } finally {
        rmSync(temporary, { force: true });
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
          syncDirectory(directory);
        } catch (error) {
          // A removal whose directory entry could not be committed is not safe to
          // acknowledge. Restore the evidence best-effort so this live process
          // also remains fail-closed; the original fsync failure still propagates.
          try {
            writeFileSync(destination, evidence, { mode: 0o600, flush: true });
            syncDirectory(directory);
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

export function readInterruptedTurn(runtime: ConversationRuntime) {
  if (!runtime.agentId || !runtime.listener.connectionId?.startsWith("conn-"))
    return null;
  return createInterruptedTurnStore().read(
    runtime.agentId,
    runtime.conversationId,
  );
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
  const inheritedCompletion = previous?.recoveryClaimCompletion
    ? recoveryLineageId === previous.recoveryClaimCompletion.lineageId
      ? previous.recoveryClaimCompletion
      : {
          ...previous.recoveryClaimCompletion,
          independentSuccessor: true,
          effectRevision:
            previous.recoveryClaimCompletion.effectRevision ??
            previous.revision,
          effectInputIdentities:
            previous.recoveryClaimCompletion.effectInputIdentities ??
            previous.durableInputIdentities,
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
    // A continuation input atomically takes ownership from its exact teleport
    // intent. Different input identities and unrelated checkpoint writes must
    // continue carrying the live intent until its own continuation is admitted.
    teleport: consumesInheritedTeleport ? undefined : previous?.teleport,
    workingDirectory:
      runtime.activeWorkingDirectory ??
      previous?.workingDirectory ??
      process.cwd(),
    ...update,
  };
  try {
    const written = store.write(
      record,
      expectedRevision === undefined
        ? (previous?.revision ?? null)
        : expectedRevision,
    );
    const durableIdentityKeys = new Set(
      (written.durableInputIdentities ?? []).map(
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
    return written.revision;
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
  while (options.shouldContinue?.() !== false) {
    try {
      return recordListenerWork(
        runtime,
        update,
        phase,
        expectedRevision,
        recoveryLineageId,
        store,
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
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

export function recordedToolResults(
  record: InterruptedTurnRecord,
  pendingToolCallIds: string[],
): ApprovalResult[] {
  const durableResults = allRecordedResults(record);
  return pendingToolCallIds.map(
    (id) =>
      durableResults.find((result) => result.tool_call_id === id) ?? {
        type: "approval",
        tool_call_id: id,
        approve: false,
        reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
      },
  );
}

export function allRecordedResults(
  record: InterruptedTurnRecord,
): ApprovalResult[] {
  const merged = new Map(
    record.results.map((result) => [result.tool_call_id, result]),
  );
  for (const effect of record.settledRecoveryEffects ?? []) {
    merged.set(effect.result.tool_call_id, effect.result);
  }
  return [...merged.values()];
}
