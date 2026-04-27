import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LaunchReflectionInput,
  LaunchReflectionResult,
} from "../../cli/helpers/autoReflection";
import {
  __idleReflectionSweepTestUtils,
  maybeStartIdleReflectionSweep,
} from "../../cli/helpers/idleReflectionSweep";
import { normalizeReflectionSettings } from "../../cli/helpers/memoryReminder";
import {
  appendTranscriptDeltaJsonl,
  buildAutoReflectionPayload,
  finalizeAutoReflectionPayload,
  getReflectionTranscriptPaths,
} from "../../cli/helpers/reflectionTranscript";
import {
  clearAllSubagents,
  registerSubagent,
} from "../../cli/helpers/subagentState";

describe("idle reflection sweep candidate discovery", () => {
  const agentId = "agent-idle-test";
  const nowMs = Date.parse("2026-04-24T12:00:00.000Z");
  let testRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "letta-idle-sweep-test-"));
    process.env.LETTA_TRANSCRIPT_ROOT = testRoot;
  });

  afterEach(async () => {
    delete process.env.LETTA_TRANSCRIPT_ROOT;
    __idleReflectionSweepTestUtils.resetInFlight();
    clearAllSubagents();
    await rm(testRoot, { recursive: true, force: true });
  });

  async function appendCompletedTurns(
    conversationId: string,
    count: number,
    startIndex = 0,
  ): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      const turnIndex = startIndex + index;
      await appendTranscriptDeltaJsonl(agentId, conversationId, [
        {
          kind: "user",
          id: `${conversationId}-u${turnIndex}`,
          text: `user ${turnIndex}`,
          messageId: `${conversationId}-msg-u${turnIndex}`,
        },
        {
          kind: "assistant",
          id: `${conversationId}-a${turnIndex}`,
          text: `assistant ${turnIndex}`,
          phase: "finished",
          messageId: `${conversationId}-msg-a${turnIndex}`,
        },
      ]);
    }
  }

  async function setTranscriptMetadata(
    conversationId: string,
    metadata: {
      transcriptAppendedMinutesAgo?: number;
      reflectionSucceededHoursAgo?: number;
    },
  ) {
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    const state = JSON.parse(await readFile(paths.statePath, "utf-8")) as {
      last_transcript_appended_at?: string;
      last_reflection_succeeded_at?: string;
    };
    if (metadata.transcriptAppendedMinutesAgo !== undefined) {
      state.last_transcript_appended_at = new Date(
        nowMs - metadata.transcriptAppendedMinutesAgo * 60 * 1000,
      ).toISOString();
    }
    if (metadata.reflectionSucceededHoursAgo !== undefined) {
      state.last_reflection_succeeded_at = new Date(
        nowMs - metadata.reflectionSucceededHoursAgo * 60 * 60 * 1000,
      ).toISOString();
    }
    await writeFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  test("filters passive candidates by active conversation, quiet window, turns, and cursor", async () => {
    await appendCompletedTurns("active", 3);
    await appendCompletedTurns("passive-good", 3);
    await appendCompletedTurns("too-short", 2);
    await appendCompletedTurns("too-noisy", 3);
    await appendCompletedTurns("already-reflected", 3);

    const reflectedPayload = await buildAutoReflectionPayload(
      agentId,
      "already-reflected",
    );
    expect(reflectedPayload).not.toBeNull();
    if (!reflectedPayload) return;
    await finalizeAutoReflectionPayload(
      agentId,
      "already-reflected",
      reflectedPayload.payloadPath,
      reflectedPayload.endSnapshotLine,
      true,
      "idle-time",
    );

    await setTranscriptMetadata("active", { transcriptAppendedMinutesAgo: 20 });
    await setTranscriptMetadata("passive-good", {
      transcriptAppendedMinutesAgo: 20,
    });
    await setTranscriptMetadata("too-short", {
      transcriptAppendedMinutesAgo: 20,
    });
    await setTranscriptMetadata("too-noisy", {
      transcriptAppendedMinutesAgo: 5,
    });
    await setTranscriptMetadata("already-reflected", {
      transcriptAppendedMinutesAgo: 20,
    });

    const candidates =
      await __idleReflectionSweepTestUtils.discoverIdleReflectionCandidates({
        agentId,
        activeConversationId: "active",
        workingDirectory: "/tmp/work",
        reflectionSettings: normalizeReflectionSettings({
          trigger: "step-count",
          stepCount: 25,
          passiveSweepEnabled: true,
          passiveSweepIntervalHours: 24,
          passiveMinQuietMinutes: 15,
          passiveMinUnreflectedTurns: 3,
        }),
        recompileContext: {
          recompileByConversation: new Map(),
          recompileQueuedByConversation: new Set(),
        },
        now: () => nowMs,
      });

    expect(candidates.map((candidate) => candidate.conversationId)).toEqual([
      "passive-good",
    ]);
  });

  test("uses reflection staleness separately from transcript quiet time", async () => {
    await appendCompletedTurns("stale-and-quiet", 3);
    await appendCompletedTurns("recent-reflection", 3);
    const reflectedPayload = await buildAutoReflectionPayload(
      agentId,
      "recent-reflection",
    );
    expect(reflectedPayload).not.toBeNull();
    if (!reflectedPayload) return;
    await finalizeAutoReflectionPayload(
      agentId,
      "recent-reflection",
      reflectedPayload.payloadPath,
      reflectedPayload.endSnapshotLine,
      true,
      "idle-time",
    );
    await appendCompletedTurns("recent-reflection", 3, 3);

    await setTranscriptMetadata("stale-and-quiet", {
      transcriptAppendedMinutesAgo: 20,
      reflectionSucceededHoursAgo: 25,
    });
    await setTranscriptMetadata("recent-reflection", {
      transcriptAppendedMinutesAgo: 20,
      reflectionSucceededHoursAgo: 1,
    });

    const candidates =
      await __idleReflectionSweepTestUtils.discoverIdleReflectionCandidates({
        agentId,
        activeConversationId: "active",
        workingDirectory: "/tmp/work",
        reflectionSettings: normalizeReflectionSettings({
          trigger: "step-count",
          stepCount: 25,
          passiveSweepEnabled: true,
          passiveSweepIntervalHours: 24,
          passiveMinQuietMinutes: 15,
          passiveMinUnreflectedTurns: 3,
        }),
        recompileContext: {
          recompileByConversation: new Map(),
          recompileQueuedByConversation: new Set(),
        },
        now: () => nowMs,
      });

    expect(candidates.map((candidate) => candidate.conversationId)).toEqual([
      "stale-and-quiet",
    ]);
  });

  test("skips candidates with active reflection subagents or busy runtimes", async () => {
    await appendCompletedTurns("passive-good", 3);
    await appendCompletedTurns("reflection-active", 3);
    await appendCompletedTurns("runtime-busy", 3);

    await setTranscriptMetadata("passive-good", {
      transcriptAppendedMinutesAgo: 20,
    });
    await setTranscriptMetadata("reflection-active", {
      transcriptAppendedMinutesAgo: 20,
    });
    await setTranscriptMetadata("runtime-busy", {
      transcriptAppendedMinutesAgo: 20,
    });

    registerSubagent(
      "reflection-subagent",
      "reflection",
      "Reflecting",
      undefined,
      true,
      true,
      { agentId, conversationId: "reflection-active" },
    );

    const candidates =
      await __idleReflectionSweepTestUtils.discoverIdleReflectionCandidates({
        agentId,
        activeConversationId: "active",
        workingDirectory: "/tmp/work",
        reflectionSettings: normalizeReflectionSettings({
          trigger: "step-count",
          stepCount: 25,
          passiveSweepEnabled: true,
          passiveSweepIntervalHours: 24,
          passiveMinQuietMinutes: 15,
          passiveMinUnreflectedTurns: 3,
        }),
        recompileContext: {
          recompileByConversation: new Map(),
          recompileQueuedByConversation: new Set(),
        },
        listenerRuntime: {
          conversationRuntimes: new Map([
            [
              "runtime-busy",
              {
                agentId,
                conversationId: "runtime-busy",
                isProcessing: true,
                isRecoveringApprovals: false,
                queuePumpActive: false,
                queuePumpScheduled: false,
                pendingTurns: 0,
                queuedMessagesByItemId: new Map(),
                queueRuntime: [],
              },
            ],
          ]),
        } as never,
        now: () => nowMs,
      });

    expect(candidates.map((candidate) => candidate.conversationId)).toEqual([
      "passive-good",
    ]);
  });

  test("sweep processes candidates sequentially and emits one aggregate notification", async () => {
    await appendCompletedTurns("idle-a", 3);
    await appendCompletedTurns("idle-b", 3);
    await appendCompletedTurns("idle-c", 3);
    await setTranscriptMetadata("idle-a", { transcriptAppendedMinutesAgo: 20 });
    await setTranscriptMetadata("idle-b", { transcriptAppendedMinutesAgo: 20 });
    await setTranscriptMetadata("idle-c", { transcriptAppendedMinutesAgo: 20 });

    const events: string[] = [];
    const notifications: string[] = [];
    let activeLaunches = 0;
    let maxActiveLaunches = 0;
    const launch = async (
      input: LaunchReflectionInput,
    ): Promise<LaunchReflectionResult> => {
      events.push(`start:${input.conversationId}`);
      activeLaunches += 1;
      maxActiveLaunches = Math.max(maxActiveLaunches, activeLaunches);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeLaunches -= 1;
      events.push(`end:${input.conversationId}`);
      return {
        status: "completed",
        success: input.conversationId !== "idle-b",
        payloadPath: `/tmp/${input.conversationId}.json`,
      };
    };

    await __idleReflectionSweepTestUtils.runIdleReflectionSweep({
      agentId,
      activeConversationId: "active",
      workingDirectory: "/tmp/work",
      reflectionSettings: normalizeReflectionSettings({
        trigger: "step-count",
        stepCount: 25,
        passiveSweepEnabled: true,
        passiveSweepIntervalHours: 24,
        passiveMinQuietMinutes: 15,
        passiveMinUnreflectedTurns: 3,
      }),
      recompileContext: {
        recompileByConversation: new Map(),
        recompileQueuedByConversation: new Set(),
      },
      launchReflectionSubagent: launch,
      emitCompletionNotification: (message) => {
        notifications.push(message);
      },
      now: () => nowMs,
    });

    expect(maxActiveLaunches).toBe(1);
    expect(events).toEqual([
      "start:idle-a",
      "end:idle-a",
      "start:idle-b",
      "end:idle-b",
      "start:idle-c",
      "end:idle-c",
    ]);
    expect(notifications).toEqual([
      "Idle reflection sweep completed: 2/3 conversation(s) reflected.",
    ]);

    const state =
      await __idleReflectionSweepTestUtils.readIdleSweepState(agentId);
    expect(state.last_idle_sweep_started_at).toBeString();
    expect(state.last_idle_sweep_completed_at).toBeString();
  });

  test("scheduler skips when not due", async () => {
    await appendCompletedTurns("idle-good", 3);
    await setTranscriptMetadata("idle-good", {
      transcriptAppendedMinutesAgo: 20,
    });
    await __idleReflectionSweepTestUtils.writeIdleSweepState(agentId, {
      last_idle_sweep_started_at: new Date(
        nowMs - 60 * 60 * 1000,
      ).toISOString(),
    });

    let launchCount = 0;
    maybeStartIdleReflectionSweep({
      agentId,
      activeConversationId: "active",
      workingDirectory: "/tmp/work",
      reflectionSettings: normalizeReflectionSettings({
        trigger: "step-count",
        stepCount: 25,
        passiveSweepEnabled: true,
        passiveSweepIntervalHours: 24,
        passiveMinQuietMinutes: 15,
        passiveMinUnreflectedTurns: 3,
      }),
      recompileContext: {
        recompileByConversation: new Map(),
        recompileQueuedByConversation: new Set(),
      },
      now: () => nowMs,
      launchReflectionSubagent: async () => {
        launchCount += 1;
        return {
          status: "completed",
          success: true,
          payloadPath: "/tmp/idle-good.json",
        };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(launchCount).toBe(0);
  });

  test("scheduler caches last-started timestamp and short-circuits without rereading state", async () => {
    await appendCompletedTurns("idle-good", 3);
    await setTranscriptMetadata("idle-good", {
      transcriptAppendedMinutesAgo: 20,
    });

    let launchCount = 0;
    const sweepInput = {
      agentId,
      activeConversationId: "active",
      workingDirectory: "/tmp/work",
      reflectionSettings: normalizeReflectionSettings({
        trigger: "step-count" as const,
        stepCount: 25,
        passiveSweepEnabled: true,
        passiveSweepIntervalHours: 24,
        passiveMinQuietMinutes: 15,
        passiveMinUnreflectedTurns: 3,
      }),
      recompileContext: {
        recompileByConversation: new Map<string, Promise<void>>(),
        recompileQueuedByConversation: new Set<string>(),
      },
      now: () => nowMs,
      launchReflectionSubagent: async () => {
        launchCount += 1;
        return {
          status: "completed" as const,
          success: true,
          payloadPath: "/tmp/idle-good.json",
        };
      },
    };

    maybeStartIdleReflectionSweep(sweepInput);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(launchCount).toBe(1);

    const sweepStatePath = join(testRoot, agentId, "idle-sweep-state.json");
    await rm(sweepStatePath, { force: true });

    maybeStartIdleReflectionSweep(sweepInput);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(launchCount).toBe(1);

    let stateFileExists = true;
    try {
      await readFile(sweepStatePath, "utf-8");
    } catch {
      stateFileExists = false;
    }
    expect(stateFileExists).toBe(false);
  });
});
