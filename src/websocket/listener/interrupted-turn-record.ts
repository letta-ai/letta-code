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
import { debugWarn } from "@/utils/debug";
import type { ConversationRuntime } from "./types";

export type ListenerStateWritePhase =
  | "run_observed"
  | "before_tool_execution"
  | "after_tool_execution";

/** Local execution evidence, never populated by observing another runtime. */
export interface InterruptedTurnRecord {
  revision?: string;
  teleportId?: string;
  actingUserId?: string;
  agentId: string;
  conversationId: string;
  runId: string | null;
  toolCallIds: string[];
  results: ApprovalResult[];
  requestOtid: string;
  workingDirectory: string;
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

export function createInterruptedTurnStore(
  directory = join(
    homedir(),
    ".letta",
    "listener-state",
    createHash("sha256").update(getServerUrl()).digest("hex").slice(0, 24),
  ),
  dependencies: { fsyncDirectory?: (directory: string) => void } = {},
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
        !Array.isArray(value.results) ||
        !value.results.every(
          (result) => result && typeof result.tool_call_id === "string",
        ) ||
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
    write(record: InterruptedTurnRecord): void {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const destination = path(record.agentId, record.conversationId);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        writeFileSync(
          temporary,
          JSON.stringify({ ...record, revision: randomUUID() }),
          {
            mode: 0o600,
            flush: true,
          },
        );
        renameSync(temporary, destination);
        syncDirectory(directory);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    remove(agentId: string, conversationId: string): void {
      const destination = path(agentId, conversationId);
      let evidence: string;
      try {
        evidence = readFileSync(destination, "utf8");
        unlinkSync(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
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
      "runId" | "toolCallIds" | "results" | "requestOtid" | "actingUserId"
    >
  >,
  phase: ListenerStateWritePhase,
): void {
  if (!runtime.agentId || !runtime.listener.connectionId?.startsWith("conn-"))
    return;
  const previous = readInterruptedTurn(runtime);
  const record: InterruptedTurnRecord = {
    agentId: runtime.agentId,
    conversationId: runtime.conversationId,
    runId: previous?.runId ?? null,
    toolCallIds: previous?.toolCallIds ?? [],
    results: previous?.results ?? [],
    requestOtid: previous?.requestOtid ?? randomUUID(),
    actingUserId: previous?.actingUserId,
    workingDirectory:
      runtime.activeWorkingDirectory ??
      previous?.workingDirectory ??
      process.cwd(),
    ...update,
  };
  const store = createInterruptedTurnStore();
  try {
    store.write(record);
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

export function forgetListenerWork(runtime: ConversationRuntime): void {
  if (runtime.agentId && runtime.listener.connectionId?.startsWith("conn-")) {
    createInterruptedTurnStore().remove(
      runtime.agentId,
      runtime.conversationId,
    );
  }
}

export function recordedToolResults(
  record: InterruptedTurnRecord,
  pendingToolCallIds: string[],
): ApprovalResult[] {
  return pendingToolCallIds.map(
    (id) =>
      record.results.find((result) => result.tool_call_id === id) ?? {
        type: "approval",
        tool_call_id: id,
        approve: false,
        reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
      },
  );
}
