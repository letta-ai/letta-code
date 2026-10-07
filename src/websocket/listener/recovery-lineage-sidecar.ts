import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ApprovalResult } from "@/agent/approval-execution";
import { isTerminalConsumerId } from "@/types/turn-finished-protocol";
import { isInputIdentity, isTeleportIntent } from "./interrupted-turn-schema";
import type { InterruptedTurnRecord } from "./interrupted-turn-types";
import type { InputIdentity } from "./types";

export interface RecoveryLineageSidecar {
  revision: string;
  agentId: string;
  conversationId: string;
  lineageId: string;
  sourceMainRevision: string;
  state: "running" | "pending" | "retired";
  runId: string | null;
  toolCallIds: string[];
  unstartedToolCallIds?: string[];
  /** Authoritative checkpoint snapshot; rollback may replace this wholesale. */
  results: ApprovalResult[];
  /** Exact post-effect settlements that must survive later rollback snapshots. */
  exactResults?: ApprovalResult[];
  requestOtid: string;
  workingDirectory: string;
  actingUserId?: string;
  durableInputIdentities?: InputIdentity[];
  terminalConsumerIds?: string[];
  teleport?: InterruptedTurnRecord["teleport"];
}

export function createRecoveryLineageSidecarAccess(params: {
  directory: string;
  syncDirectory: (directory: string) => void;
}) {
  const path = (
    agentId: string,
    conversationId: string,
    lineageId: string,
  ): string =>
    join(
      params.directory,
      `${encodeURIComponent(agentId)}_${encodeURIComponent(conversationId)}.json.recovery-${createHash(
        "sha256",
      )
        .update(lineageId)
        .digest("hex")
        .slice(0, 24)}`,
    );

  const isSidecar = (value: unknown): value is RecoveryLineageSidecar => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<RecoveryLineageSidecar>;
    return (
      typeof candidate.revision === "string" &&
      typeof candidate.lineageId === "string" &&
      typeof candidate.sourceMainRevision === "string" &&
      (candidate.state === "running" ||
        candidate.state === "pending" ||
        candidate.state === "retired") &&
      typeof candidate.agentId === "string" &&
      typeof candidate.conversationId === "string" &&
      (candidate.runId === null || typeof candidate.runId === "string") &&
      Array.isArray(candidate.toolCallIds) &&
      candidate.toolCallIds.every((id) => typeof id === "string") &&
      Array.isArray(candidate.results) &&
      candidate.results.every(
        (result) => result && typeof result.tool_call_id === "string",
      ) &&
      (candidate.exactResults === undefined ||
        (Array.isArray(candidate.exactResults) &&
          candidate.exactResults.every(
            (result) => result && typeof result.tool_call_id === "string",
          ))) &&
      (candidate.unstartedToolCallIds === undefined ||
        (Array.isArray(candidate.unstartedToolCallIds) &&
          candidate.unstartedToolCallIds.every(
            (id) => typeof id === "string",
          ))) &&
      (candidate.actingUserId === undefined ||
        typeof candidate.actingUserId === "string") &&
      (candidate.durableInputIdentities === undefined ||
        (Array.isArray(candidate.durableInputIdentities) &&
          candidate.durableInputIdentities.every(isInputIdentity))) &&
      (candidate.terminalConsumerIds === undefined ||
        (Array.isArray(candidate.terminalConsumerIds) &&
          candidate.terminalConsumerIds.every(isTerminalConsumerId))) &&
      (candidate.teleport === undefined ||
        isTeleportIntent(candidate.teleport)) &&
      typeof candidate.requestOtid === "string" &&
      typeof candidate.workingDirectory === "string"
    );
  };

  const read = (
    agentId: string,
    conversationId: string,
    lineageId: string,
  ): RecoveryLineageSidecar | null => {
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(path(agentId, conversationId, lineageId), "utf8"),
      );
      if (
        !isSidecar(parsed) ||
        parsed.agentId !== agentId ||
        parsed.conversationId !== conversationId ||
        parsed.lineageId !== lineageId
      ) {
        throw new Error("Invalid recovery-lineage sidecar");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };

  const write = (sidecar: RecoveryLineageSidecar): void => {
    mkdirSync(params.directory, { recursive: true, mode: 0o700 });
    const destination = path(
      sidecar.agentId,
      sidecar.conversationId,
      sidecar.lineageId,
    );
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(sidecar), {
        mode: 0o600,
        flush: true,
      });
      renameSync(temporary, destination);
      params.syncDirectory(params.directory);
    } finally {
      rmSync(temporary, { force: true });
    }
  };

  const initial = (current: InterruptedTurnRecord): RecoveryLineageSidecar => {
    const marker = current.recoveryClaimCompletion;
    if (
      !marker?.independentSuccessor ||
      !current.revision ||
      !marker.effectRevision
    ) {
      throw new Error("Independent recovery lineage is not durable");
    }
    const exactResults: ApprovalResult[] = [];
    for (const effect of current.settledRecoveryEffects ?? []) {
      if (effect.lineageId !== marker.lineageId) continue;
      const index = exactResults.findIndex(
        (result) => result.tool_call_id === effect.result.tool_call_id,
      );
      if (index >= 0) exactResults[index] = effect.result;
      else exactResults.push(effect.result);
    }
    return {
      revision: randomUUID(),
      agentId: current.agentId,
      conversationId: current.conversationId,
      lineageId: marker.lineageId,
      sourceMainRevision: marker.effectRevision,
      state: marker.state,
      runId: marker.effectRunId ?? null,
      toolCallIds: [...(marker.effectToolCallIds ?? [])],
      unstartedToolCallIds: marker.effectUnstartedToolCallIds
        ? [...marker.effectUnstartedToolCallIds]
        : undefined,
      results: [...(marker.effectResults ?? [])],
      exactResults,
      requestOtid: marker.effectRequestOtid ?? current.requestOtid,
      workingDirectory:
        marker.effectWorkingDirectory ?? current.workingDirectory,
      actingUserId: marker.effectActingUserId ?? undefined,
      durableInputIdentities: [...(marker.effectInputIdentities ?? [])],
      terminalConsumerIds: [...(marker.effectTerminalConsumerIds ?? [])],
      teleport: marker.effectTeleport,
    };
  };

  const recoveryView = (
    current: InterruptedTurnRecord,
  ): InterruptedTurnRecord | null => {
    const marker = current.recoveryClaimCompletion;
    if (!marker) return current;
    if (!marker.independentSuccessor) return current;
    const sidecar = read(
      current.agentId,
      current.conversationId,
      marker.lineageId,
    );
    if (sidecar?.state === "retired") return null;
    const effect = sidecar ?? initial(current);
    const results = new Map(
      effect.results.map((result) => [result.tool_call_id, result]),
    );
    for (const result of effect.exactResults ?? []) {
      results.set(result.tool_call_id, result);
    }
    return {
      ...current,
      revision: effect.sourceMainRevision,
      runId: effect.runId,
      toolCallIds: [...effect.toolCallIds],
      unstartedToolCallIds: effect.unstartedToolCallIds
        ? [...effect.unstartedToolCallIds]
        : undefined,
      results: [...results.values()],
      settledRecoveryEffects: undefined,
      requestOtid: effect.requestOtid,
      workingDirectory: effect.workingDirectory,
      actingUserId: effect.actingUserId,
      durableInputIdentities: effect.durableInputIdentities
        ? [...effect.durableInputIdentities]
        : undefined,
      terminalConsumerIds: effect.terminalConsumerIds
        ? [...effect.terminalConsumerIds]
        : undefined,
      teleport: effect.teleport,
      recoveryClaimCompletion: {
        ...marker,
        state: effect.state === "pending" ? "pending" : "running",
      },
    };
  };

  const mainView = (current: InterruptedTurnRecord): InterruptedTurnRecord => {
    const marker = current.recoveryClaimCompletion;
    if (!marker?.independentSuccessor) return current;
    const sidecar = read(
      current.agentId,
      current.conversationId,
      marker.lineageId,
    );
    if (!sidecar) return current;
    if (sidecar.state === "pending") {
      return {
        ...current,
        recoveryClaimCompletion: { ...marker, state: "pending" },
      };
    }
    if (sidecar.state !== "retired") return current;
    const retiredToolCallIds = new Set(sidecar.toolCallIds);
    return {
      ...current,
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
      teleport:
        sidecar.teleport &&
        current.teleport?.teleportId === sidecar.teleport.teleportId
          ? undefined
          : current.teleport,
      settledRecoveryEffects: current.settledRecoveryEffects?.filter(
        (effect) => effect.lineageId !== marker.lineageId,
      ),
    };
  };

  const snapshot = (
    current: InterruptedTurnRecord,
  ): { record: InterruptedTurnRecord; revisionToken: string } | null => {
    const marker = current.recoveryClaimCompletion;
    if (!marker?.independentSuccessor) return null;
    const record = recoveryView(current);
    if (!record) return null;
    const sidecar = read(
      current.agentId,
      current.conversationId,
      marker.lineageId,
    );
    return {
      record,
      revisionToken: sidecar?.revision ?? `main:${current.revision ?? "none"}`,
    };
  };

  const remove = (sidecar: RecoveryLineageSidecar): void => {
    rmSync(path(sidecar.agentId, sidecar.conversationId, sidecar.lineageId), {
      force: true,
    });
    params.syncDirectory(params.directory);
  };

  const list = (): RecoveryLineageSidecar[] => {
    const removeMalformedOrphan = (file: string) => {
      const separator = file.indexOf(".recovery-");
      const mainFile = separator >= 0 ? file.slice(0, separator) : "";
      if (!mainFile || existsSync(join(params.directory, mainFile))) return;
      try {
        rmSync(join(params.directory, file), { force: true });
        params.syncDirectory(params.directory);
      } catch {}
    };
    try {
      return readdirSync(params.directory)
        .filter((file) => file.includes(".json.recovery-"))
        .flatMap((file) => {
          try {
            const value: unknown = JSON.parse(
              readFileSync(join(params.directory, file), "utf8"),
            );
            if (isSidecar(value)) return [value];
            removeMalformedOrphan(file);
            return [];
          } catch {
            removeMalformedOrphan(file);
            return [];
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };

  return {
    initial,
    list,
    mainView,
    read,
    recoveryView,
    remove,
    snapshot,
    write,
  };
}
