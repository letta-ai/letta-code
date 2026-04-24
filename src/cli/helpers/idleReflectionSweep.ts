import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { telemetry } from "../../telemetry";
import { debugLog, debugWarn } from "../../utils/debug";
import type { ListenerRuntime } from "../../websocket/listener/types";
import {
  launchReflectionSubagent,
  type ReflectionRecompileContext,
} from "./autoReflection";
import {
  normalizeReflectionSettings,
  type ReflectionSettings,
} from "./memoryReminder";
import { isReflectionSubagentActive } from "./reflectionGate";
import {
  getReflectionTranscriptAgentRoot,
  getReflectionTranscriptDerivedState,
  listReflectionTranscriptConversationIds,
} from "./reflectionTranscript";
import { getSubagents } from "./subagentState";

type IdleSweepState = {
  last_idle_sweep_started_at?: string;
  last_idle_sweep_completed_at?: string;
};

export type IdleReflectionSweepInput = {
  agentId: string;
  activeConversationId: string;
  workingDirectory: string;
  reflectionSettings: ReflectionSettings;
  recompileContext: ReflectionRecompileContext;
  listenerRuntime?: ListenerRuntime;
  emitCompletionNotification?: (message: string) => void | Promise<void>;
};

type IdleReflectionCandidate = {
  conversationId: string;
};

const idleSweepInFlightByAgent = new Set<string>();

function getIdleSweepStatePath(agentId: string): string {
  return join(
    getReflectionTranscriptAgentRoot(agentId),
    "idle-sweep-state.json",
  );
}

async function readIdleSweepState(agentId: string): Promise<IdleSweepState> {
  try {
    const raw = await readFile(getIdleSweepStatePath(agentId), "utf-8");
    const parsed = JSON.parse(raw) as Partial<IdleSweepState>;
    return {
      last_idle_sweep_started_at:
        typeof parsed.last_idle_sweep_started_at === "string"
          ? parsed.last_idle_sweep_started_at
          : undefined,
      last_idle_sweep_completed_at:
        typeof parsed.last_idle_sweep_completed_at === "string"
          ? parsed.last_idle_sweep_completed_at
          : undefined,
    };
  } catch {
    return {};
  }
}

async function writeIdleSweepState(
  agentId: string,
  state: IdleSweepState,
): Promise<void> {
  const root = getReflectionTranscriptAgentRoot(agentId);
  await mkdir(root, { recursive: true });
  await writeFile(
    getIdleSweepStatePath(agentId),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf-8",
  );
}

function hoursSince(iso: string | undefined, nowMs: number): number {
  if (!iso) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return Number.POSITIVE_INFINITY;
  }
  return (nowMs - parsed) / (60 * 60 * 1000);
}

function isConversationRuntimeBusy(
  listenerRuntime: ListenerRuntime | undefined,
  agentId: string,
  conversationId: string,
): boolean {
  if (!listenerRuntime) {
    return false;
  }
  for (const runtime of listenerRuntime.conversationRuntimes.values()) {
    if (
      runtime.agentId !== agentId ||
      runtime.conversationId !== conversationId
    ) {
      continue;
    }
    return (
      runtime.isProcessing ||
      runtime.isRecoveringApprovals ||
      runtime.queuePumpActive ||
      runtime.queuePumpScheduled ||
      runtime.pendingTurns > 0 ||
      runtime.queuedMessagesByItemId.size > 0 ||
      (runtime.queueRuntime?.length ?? 0) > 0
    );
  }
  return false;
}

async function discoverIdleReflectionCandidates(
  input: IdleReflectionSweepInput,
): Promise<IdleReflectionCandidate[]> {
  const nowMs = Date.now();
  const reflectionSettings = normalizeReflectionSettings(
    input.reflectionSettings,
  );
  const conversationIds = await listReflectionTranscriptConversationIds(
    input.agentId,
  );
  const candidates: IdleReflectionCandidate[] = [];

  for (const conversationId of conversationIds) {
    if (conversationId === input.activeConversationId) {
      continue;
    }
    if (
      isReflectionSubagentActive(getSubagents(), input.agentId, conversationId)
    ) {
      continue;
    }
    if (
      isConversationRuntimeBusy(
        input.listenerRuntime,
        input.agentId,
        conversationId,
      )
    ) {
      continue;
    }

    const derived = await getReflectionTranscriptDerivedState(
      input.agentId,
      conversationId,
    );
    if (!derived.hasUnreflectedMessages) {
      continue;
    }
    if (
      derived.unreflectedCompletedTurns <
      reflectionSettings.idleMinUnreflectedTurns
    ) {
      continue;
    }
    if (
      hoursSince(derived.state.last_transcript_appended_at, nowMs) <
      reflectionSettings.idleConversationMinAgeHours
    ) {
      continue;
    }
    candidates.push({ conversationId });
  }

  return candidates;
}

export const __idleReflectionSweepTestUtils = {
  discoverIdleReflectionCandidates,
};

async function runIdleReflectionSweep(
  input: IdleReflectionSweepInput,
): Promise<void> {
  const startedAt = Date.now();
  const state = await readIdleSweepState(input.agentId);
  state.last_idle_sweep_started_at = new Date(startedAt).toISOString();
  await writeIdleSweepState(input.agentId, state);

  let candidates: IdleReflectionCandidate[] = [];
  let launchedCount = 0;
  let successCount = 0;
  try {
    candidates = await discoverIdleReflectionCandidates(input);
    debugLog(
      "memory",
      `Idle reflection sweep found ${candidates.length} candidate(s) for agent ${input.agentId}`,
    );

    for (const candidate of candidates) {
      const result = await launchReflectionSubagent({
        agentId: input.agentId,
        conversationId: candidate.conversationId,
        workingDirectory: input.workingDirectory,
        triggerSource: "idle-time",
        waitForCompletion: true,
        recompileContext: input.recompileContext,
      });
      if (result.launched) {
        launchedCount += 1;
      }
      if (result.success) {
        successCount += 1;
      }
    }

    state.last_idle_sweep_completed_at = new Date().toISOString();
    await writeIdleSweepState(input.agentId, state);
  } catch (error) {
    debugWarn(
      "memory",
      `Idle reflection sweep failed for agent ${input.agentId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    const durationMs = Date.now() - startedAt;
    telemetry.trackReflectionIdleSweep({
      agentId: input.agentId,
      candidateCount: candidates.length,
      launchedCount,
      successCount,
      durationMs,
    });
    if (launchedCount > 0) {
      await input.emitCompletionNotification?.(
        `Idle reflection sweep completed: ${successCount}/${launchedCount} conversation(s) reflected.`,
      );
    }
  }
}

export function maybeStartIdleReflectionSweep(
  input: IdleReflectionSweepInput,
): void {
  const reflectionSettings = normalizeReflectionSettings(
    input.reflectionSettings,
  );
  if (!reflectionSettings.idleSweepEnabled) {
    return;
  }
  if (idleSweepInFlightByAgent.has(input.agentId)) {
    return;
  }
  idleSweepInFlightByAgent.add(input.agentId);

  void (async () => {
    const state = await readIdleSweepState(input.agentId);
    if (
      hoursSince(state.last_idle_sweep_started_at, Date.now()) <
      reflectionSettings.idleSweepIntervalHours
    ) {
      idleSweepInFlightByAgent.delete(input.agentId);
      return;
    }

    try {
      await runIdleReflectionSweep(input);
    } finally {
      idleSweepInFlightByAgent.delete(input.agentId);
    }
  })().catch((error) => {
    debugWarn(
      "memory",
      `Failed to schedule idle reflection sweep: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    idleSweepInFlightByAgent.delete(input.agentId);
  });
}
