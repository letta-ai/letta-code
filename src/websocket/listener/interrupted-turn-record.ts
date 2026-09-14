import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApprovalResult } from "@/agent/approval-execution";
import { STALE_APPROVAL_RECOVERY_DENIAL_REASON } from "@/agent/turn-recovery-policy";
import { getServerUrl } from "@/backend/api/server-url";
import type { ConversationRuntime } from "./types";

/** Local execution evidence, never populated by observing another runtime. */
export interface InterruptedTurnRecord {
  agentId: string;
  conversationId: string;
  runId: string | null;
  toolCallIds: string[];
  results: ApprovalResult[];
  requestOtid: string;
  workingDirectory: string;
}

export function createInterruptedTurnStore(
  directory = join(
    homedir(),
    ".letta",
    "listener-state",
    createHash("sha256").update(getServerUrl()).digest("hex").slice(0, 24),
  ),
) {
  function path(agentId: string, conversationId: string) {
    return join(
      directory,
      `${encodeURIComponent(agentId)}_${encodeURIComponent(conversationId)}.json`,
    );
  }
  return {
    list(): InterruptedTurnRecord[] {
      try {
        return readdirSync(directory)
          .filter((file) => file.endsWith(".json"))
          .map(
            (file) =>
              JSON.parse(
                readFileSync(join(directory, file), "utf8"),
              ) as InterruptedTurnRecord,
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    read(
      agentId: string,
      conversationId: string,
    ): InterruptedTurnRecord | null {
      try {
        const value = JSON.parse(
          readFileSync(path(agentId, conversationId), "utf8"),
        ) as InterruptedTurnRecord;
        if (
          value.agentId !== agentId ||
          value.conversationId !== conversationId ||
          !Array.isArray(value.toolCallIds) ||
          !Array.isArray(value.results) ||
          typeof value.requestOtid !== "string" ||
          typeof value.workingDirectory !== "string"
        ) {
          throw new Error("Invalid interrupted-turn record");
        }
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    write(record: InterruptedTurnRecord): void {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const destination = path(record.agentId, record.conversationId);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(record), {
          mode: 0o600,
          flush: true,
        });
        renameSync(temporary, destination);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    remove(agentId: string, conversationId: string): void {
      rmSync(path(agentId, conversationId), { force: true });
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
      "runId" | "toolCallIds" | "results" | "requestOtid"
    >
  >,
): void {
  if (!runtime.agentId || !runtime.listener.connectionId?.startsWith("conn-"))
    return;
  const previous = readInterruptedTurn(runtime);
  createInterruptedTurnStore().write({
    agentId: runtime.agentId,
    conversationId: runtime.conversationId,
    runId: previous?.runId ?? null,
    toolCallIds: previous?.toolCallIds ?? [],
    results: previous?.results ?? [],
    requestOtid: previous?.requestOtid ?? randomUUID(),
    workingDirectory:
      runtime.activeWorkingDirectory ??
      previous?.workingDirectory ??
      process.cwd(),
    ...update,
  });
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
        tool_call_id: id,
        approve: false,
        reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
      },
  );
}
