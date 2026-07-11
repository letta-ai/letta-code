import {
  type CronRunLogAction,
  type CronRunLogRunEntryInput,
  safeAppendCronRunLogForCronRun,
} from "@/cron/run-log";
import type { StopReasonType } from "@/types/protocol_v2";
import type { IncomingMessage } from "./types";

type TerminalCronRunLogAction = Extract<
  CronRunLogAction,
  "completed" | "failed" | "cancelled"
>;

function withBackendRunId(
  backendRunId: string | null | undefined,
): Pick<CronRunLogRunEntryInput, "runId" | "backendRunId"> {
  return backendRunId ? { runId: backendRunId, backendRunId } : {};
}

export function createCronTurnRunLogger(params: {
  msg: IncomingMessage;
  agentId?: string;
  conversationId: string;
  getBatchId: () => string;
  getBackendRunId: () => string | undefined;
  isCancellationRequested: () => boolean;
}) {
  const loggedBackendRunIds = new Set<string>();
  let terminalLogged = false;

  const recordLifecycle = (
    action: CronRunLogAction,
    entry: Omit<CronRunLogRunEntryInput, "action">,
  ): void => {
    const cronRuns = params.msg.cronRuns;
    if (!cronRuns || cronRuns.length === 0) {
      return;
    }
    for (const cronRun of cronRuns) {
      safeAppendCronRunLogForCronRun(
        {
          jobId: cronRun.cronTaskId,
          cronRunId: cronRun.cronRunId,
          queueItemId: cronRun.queueItemId,
          agentId: cronRun.agentId ?? params.agentId,
          conversationId: cronRun.conversationId ?? params.conversationId,
        },
        {
          ...entry,
          action,
          batchId: entry.batchId ?? cronRun.batchId ?? params.getBatchId(),
          queueItemId: entry.queueItemId ?? cronRun.queueItemId,
          agentId: entry.agentId ?? cronRun.agentId ?? params.agentId,
          conversationId:
            entry.conversationId ??
            cronRun.conversationId ??
            params.conversationId,
        },
      );
    }
  };

  const recordTerminal = (
    action: TerminalCronRunLogAction,
    entry: Omit<CronRunLogRunEntryInput, "action">,
  ): void => {
    if (terminalLogged) {
      return;
    }
    terminalLogged = true;
    recordLifecycle(action, entry);
  };

  const completed = (backendRunId = params.getBackendRunId()): void => {
    recordTerminal("completed", {
      status: "ok",
      summary: "completed",
      stopReason: "end_turn",
      ...withBackendRunId(backendRunId),
    });
  };

  const cancelled = (backendRunId = params.getBackendRunId()): void => {
    recordTerminal("cancelled", {
      status: "skipped",
      summary: "cancelled",
      stopReason: "cancelled",
      ...withBackendRunId(backendRunId),
    });
  };

  const failed = (options: {
    summary: string;
    stopReason?: StopReasonType | string;
    error?: string | null;
    errorClass?: string;
    errorMessage?: string | null;
    backendRunId?: string | null;
  }): void => {
    recordTerminal("failed", {
      status: "error",
      summary: options.summary,
      stopReason: options.stopReason ?? "error",
      ...(options.error ? { error: options.error } : {}),
      ...(options.errorClass ? { errorClass: options.errorClass } : {}),
      ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
      ...withBackendRunId(options.backendRunId ?? params.getBackendRunId()),
    });
  };

  return {
    turnStarted(): void {
      recordLifecycle("turn_started", {
        status: "ok",
        batchId: params.getBatchId(),
      });
    },
    backendRunStarted(backendRunId: string): void {
      if (loggedBackendRunIds.has(backendRunId)) {
        return;
      }
      loggedBackendRunIds.add(backendRunId);
      recordLifecycle("backend_run_started", {
        status: "ok",
        runId: backendRunId,
        backendRunId,
        batchId: params.getBatchId(),
      });
    },
    missingAgent(): void {
      failed({
        summary: "missing_agent",
        error: "Missing agent id",
        errorClass: "MissingAgentId",
        errorMessage: "Missing agent id",
      });
    },
    cancelled,
    completed,
    failed,
    streamUnavailable(): void {
      if (params.isCancellationRequested()) {
        cancelled();
        return;
      }
      failed({
        summary: "stream_unavailable",
        error: "No stream returned",
        errorClass: "StreamUnavailable",
        errorMessage: "No stream returned",
      });
    },
    recoveryTerminal(
      stopReason: StopReasonType | null | undefined,
      backendRunId = params.getBackendRunId(),
    ): void {
      if (stopReason === "end_turn") {
        completed(backendRunId);
        return;
      }
      if (stopReason === "cancelled") {
        cancelled(backendRunId);
        return;
      }
      const summary = stopReason || "error";
      failed({
        summary,
        stopReason: summary,
        error: `Recovery continuation ended unexpectedly: ${summary}`,
        errorClass: summary,
        errorMessage: `Recovery continuation ended unexpectedly: ${summary}`,
        backendRunId,
      });
    },
    setupCancelled(errorMessage: string): void {
      recordTerminal("cancelled", {
        status: "skipped",
        summary: "cancelled",
        stopReason: "cancelled",
        error: errorMessage,
        errorClass: "CancelledSetup",
        errorMessage,
      });
    },
    unfinalizedExit(
      stopReason: "cancelled" | "error",
      backendRunId?: string,
    ): void {
      if (stopReason === "cancelled") {
        cancelled(backendRunId);
        return;
      }
      failed({
        summary: "unfinalized_exit",
        stopReason,
        error: "Turn owner exited without a terminal transition",
        errorClass: "UnfinalizedTurnExit",
        errorMessage: "Turn owner exited without a terminal transition",
        backendRunId,
      });
    },
  };
}
