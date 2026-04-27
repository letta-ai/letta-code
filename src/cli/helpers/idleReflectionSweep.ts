import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { telemetry } from "../../telemetry";
import { debugLog, debugWarn } from "../../utils/debug";
import { withFileLock } from "../../utils/fileLock";
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
  getReflectionTranscriptState,
  listReflectionTranscriptConversationIds,
} from "./reflectionTranscript";
import { getSubagents } from "./subagentState";

type IdleSweepState = {
  last_idle_sweep_started_at?: string;
  last_idle_sweep_completed_at?: string;
};

export type IdleReflectionSweepInput = {
  agentId: string;
  workingDirectory: string;
  reflectionSettings: ReflectionSettings;
  recompileContext: ReflectionRecompileContext;
  listenerRuntime?: ListenerRuntime;
  emitCompletionNotification?: (message: string) => void | Promise<void>;
  now?: () => number;
  launchReflectionSubagent?: typeof launchReflectionSubagent;
};

type IdleReflectionCandidate = {
  conversationId: string;
};

const idleSweepInFlightByAgent = new Set<string>();
const idleSweepLastStartedAtByAgent = new Map<string, number>();
const HOUR_MS = 60 * 60 * 1000;

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

function minutesSince(iso: string | undefined, nowMs: number): number {
  if (!iso) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return Number.POSITIVE_INFINITY;
  }
  return (nowMs - parsed) / (60 * 1000);
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
  const nowMs = input.now?.() ?? Date.now();
  const settings = normalizeReflectionSettings(input.reflectionSettings);
  const conversationIds = await listReflectionTranscriptConversationIds(
    input.agentId,
  );

  const eligible = conversationIds.filter(
    (conversationId) =>
      !isReflectionSubagentActive(
        getSubagents(),
        input.agentId,
        conversationId,
      ) &&
      !isConversationRuntimeBusy(
        input.listenerRuntime,
        input.agentId,
        conversationId,
      ),
  );

  const phase1 = await Promise.all(
    eligible.map(async (conversationId) => {
      const state = await getReflectionTranscriptState(
        input.agentId,
        conversationId,
      );
      const unreflectedTurns = Math.max(
        0,
        state.total_completed_turns - state.reflected_completed_turns,
      );
      if (unreflectedTurns < settings.passiveMinUnreflectedTurns) {
        return null;
      }
      if (
        hoursSince(state.last_reflection_succeeded_at, nowMs) <
        settings.passiveSweepIntervalHours
      ) {
        return null;
      }
      if (
        minutesSince(state.last_transcript_appended_at, nowMs) <
        settings.passiveMinQuietMinutes
      ) {
        return null;
      }
      return conversationId;
    }),
  );
  const survivors = phase1.filter((id): id is string => id !== null);

  const phase2 = await Promise.all(
    survivors.map(async (conversationId) => {
      const derived = await getReflectionTranscriptDerivedState(
        input.agentId,
        conversationId,
      );
      return derived.hasUnreflectedMessages ? { conversationId } : null;
    }),
  );
  return phase2.filter(
    (candidate): candidate is IdleReflectionCandidate => candidate !== null,
  );
}

async function runIdleReflectionSweep(
  input: IdleReflectionSweepInput,
): Promise<void> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const state = await readIdleSweepState(input.agentId);
  state.last_idle_sweep_started_at = new Date(startedAt).toISOString();
  await writeIdleSweepState(input.agentId, state);
  idleSweepLastStartedAtByAgent.set(input.agentId, startedAt);

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
      const launch = input.launchReflectionSubagent ?? launchReflectionSubagent;
      const result = await launch({
        agentId: input.agentId,
        conversationId: candidate.conversationId,
        workingDirectory: input.workingDirectory,
        triggerSource: "idle-time",
        waitUntil: "completed",
        recompileContext: input.recompileContext,
      });
      if (result.status === "completed") {
        launchedCount += 1;
        if (result.success) {
          successCount += 1;
        }
      }
    }

    state.last_idle_sweep_completed_at = new Date(now()).toISOString();
    await writeIdleSweepState(input.agentId, state);
  } catch (error) {
    debugWarn(
      "memory",
      `Idle reflection sweep failed for agent ${input.agentId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    const durationMs = now() - startedAt;
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
  if (!reflectionSettings.passiveSweepEnabled) {
    return;
  }
  if (idleSweepInFlightByAgent.has(input.agentId)) {
    return;
  }
  idleSweepInFlightByAgent.add(input.agentId);

  void (async () => {
    const now = input.now ?? Date.now;
    const intervalMs = reflectionSettings.passiveSweepIntervalHours * HOUR_MS;
    const cachedStartedAt = idleSweepLastStartedAtByAgent.get(input.agentId);
    if (cachedStartedAt !== undefined && now() - cachedStartedAt < intervalMs) {
      idleSweepInFlightByAgent.delete(input.agentId);
      return;
    }

    const root = getReflectionTranscriptAgentRoot(input.agentId);
    await mkdir(root, { recursive: true });
    const lockPath = join(root, "idle-sweep-state.json.lock");

    let claimed = false;
    await withFileLock(lockPath, async () => {
      const state = await readIdleSweepState(input.agentId);
      const persistedStartedAt = state.last_idle_sweep_started_at
        ? Date.parse(state.last_idle_sweep_started_at)
        : Number.NaN;
      if (Number.isFinite(persistedStartedAt)) {
        idleSweepLastStartedAtByAgent.set(input.agentId, persistedStartedAt);
        if (now() - persistedStartedAt < intervalMs) {
          return;
        }
      }
      const claimedAt = now();
      state.last_idle_sweep_started_at = new Date(claimedAt).toISOString();
      await writeIdleSweepState(input.agentId, state);
      idleSweepLastStartedAtByAgent.set(input.agentId, claimedAt);
      claimed = true;
    });

    if (!claimed) {
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

export const __idleReflectionSweepTestUtils = {
  discoverIdleReflectionCandidates,
  readIdleSweepState,
  writeIdleSweepState,
  runIdleReflectionSweep,
  resetInFlight() {
    idleSweepInFlightByAgent.clear();
    idleSweepLastStartedAtByAgent.clear();
  },
};
