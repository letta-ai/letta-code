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
