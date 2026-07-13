import type { ChannelTurnProgressBuilder } from "@/channels/progress-builder";
import { getChannelRegistry } from "@/channels/registry";
import type { ChannelTurnOutcome, ChannelTurnSource } from "@/channels/types";
import type { StopReasonType } from "@/types/protocol_v2";

export type ActiveChannelTurn = {
  sources: ChannelTurnSource[];
  batchId: string;
  progress: ChannelTurnProgressBuilder | null;
  contextRecovered: boolean;
};

export type ChannelTurnRuntimeCarrier = {
  activeChannelTurn: ActiveChannelTurn | null;
};

function getChannelTurnSourceKey(source: ChannelTurnSource): string {
  return [
    source.channel,
    source.accountId ?? "",
    source.chatId,
    source.threadId ?? "",
  ].join(":");
}

export function uniqueChannelTurnSources(
  sources: ChannelTurnSource[],
): ChannelTurnSource[] {
  const sourcesByKey = new Map<string, ChannelTurnSource>();
  for (const source of sources) {
    sourcesByKey.set(getChannelTurnSourceKey(source), source);
  }
  return [...sourcesByKey.values()];
}

export function activateChannelTurn(
  runtime: ChannelTurnRuntimeCarrier,
  turn: ActiveChannelTurn,
): ActiveChannelTurn {
  const activeTurn = {
    ...turn,
    sources: [...turn.sources],
  };
  runtime.activeChannelTurn = activeTurn;
  return activeTurn;
}

export function recoverActiveChannelTurn(
  runtime: ChannelTurnRuntimeCarrier,
  turn: Omit<ActiveChannelTurn, "contextRecovered">,
): ActiveChannelTurn {
  return activateChannelTurn(runtime, {
    ...turn,
    contextRecovered: true,
  });
}

export function clearActiveChannelTurn(
  runtime: ChannelTurnRuntimeCarrier,
): void {
  runtime.activeChannelTurn = null;
}

export function getActiveChannelTurnProgressContext(
  runtime: ChannelTurnRuntimeCarrier,
): {
  sources: ChannelTurnSource[];
  batchId: string;
  progressBuilder: ChannelTurnProgressBuilder;
} | null {
  const activeTurn = runtime.activeChannelTurn;
  if (!activeTurn || activeTurn.sources.length === 0 || !activeTurn.progress) {
    return null;
  }
  return {
    sources: activeTurn.sources,
    batchId: activeTurn.batchId,
    progressBuilder: activeTurn.progress,
  };
}

export async function dispatchChannelTurnLifecycleEvent(
  event:
    | {
        type: "processing";
        batchId: string;
        sources: ChannelTurnSource[];
      }
    | {
        type: "finished";
        batchId: string;
        sources: ChannelTurnSource[];
        outcome: ChannelTurnOutcome;
        stopReason: StopReasonType;
        error?: string;
        runId?: string;
      },
): Promise<void> {
  if (event.sources.length === 0) return;

  const registry = getChannelRegistry();
  if (!registry) return;

  if (event.type === "processing") {
    await registry.dispatchTurnLifecycleEvent(event);
    return;
  }

  await registry.dispatchTurnLifecycleEvent({
    type: "finished",
    batchId: event.batchId,
    sources: event.sources,
    outcome: event.outcome,
    stopReason: event.stopReason,
    ...(event.error ? { error: event.error } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
  });
}

export function resolveTurnLifecycleTerminal(
  lastStopReason: string | null,
  didThrow: boolean,
): { outcome: ChannelTurnOutcome; stopReason: StopReasonType } {
  const stopReason = (
    didThrow &&
    (!lastStopReason ||
      lastStopReason === "end_turn" ||
      lastStopReason === "requires_approval")
      ? "error"
      : (lastStopReason ?? "error")
  ) as StopReasonType;
  if (stopReason === "cancelled") {
    return { outcome: "cancelled", stopReason };
  }
  if (stopReason === "end_turn" || stopReason === "tool_rule") {
    return { outcome: "completed", stopReason };
  }
  return { outcome: "error", stopReason };
}

export async function finishActiveChannelTurn(
  runtime: ChannelTurnRuntimeCarrier,
  options: {
    lastStopReason: string | null;
    didThrow: boolean;
    error?: string;
    runId?: string;
    retainOnApproval?: boolean;
  },
): Promise<{
  terminal: ReturnType<typeof resolveTurnLifecycleTerminal>;
  dispatched: boolean;
}> {
  const terminal = resolveTurnLifecycleTerminal(
    options.lastStopReason,
    options.didThrow,
  );
  const activeTurn = runtime.activeChannelTurn;

  if (terminal.stopReason === "requires_approval") {
    if (!options.retainOnApproval) clearActiveChannelTurn(runtime);
    return { terminal, dispatched: false };
  }

  // Clear before the async dispatch so re-entrant cleanup cannot emit a
  // second terminal event for the same turn.
  clearActiveChannelTurn(runtime);
  if (!activeTurn || activeTurn.sources.length === 0) {
    return { terminal, dispatched: false };
  }

  await dispatchChannelTurnLifecycleEvent({
    type: "finished",
    batchId: activeTurn.batchId,
    sources: activeTurn.sources,
    outcome: terminal.outcome,
    stopReason: terminal.stopReason,
    ...(terminal.outcome === "error" && options.error
      ? { error: options.error }
      : {}),
    ...(options.runId ? { runId: options.runId } : {}),
  });
  return { terminal, dispatched: true };
}
