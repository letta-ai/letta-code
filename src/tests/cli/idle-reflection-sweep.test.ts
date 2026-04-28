import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __autoReflectionTestUtils,
  type LaunchReflectionInput,
  type LaunchReflectionResult,
  launchReflectionSubagent,
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
  getReflectionTranscriptDerivedState,
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
      transcriptAppendedHoursAgo?: number;
    },
  ) {
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    const state = JSON.parse(await readFile(paths.statePath, "utf-8")) as {
      last_transcript_appended_at?: string;
    };
    if (metadata.transcriptAppendedHoursAgo !== undefined) {
      state.last_transcript_appended_at = new Date(
        nowMs - metadata.transcriptAppendedHoursAgo * 60 * 60 * 1000,
      ).toISOString();
    }
    await writeFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  test("filters passive candidates by quiet window, turns, and cursor", async () => {
    await appendCompletedTurns("quiet-recently", 3);
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

    await setTranscriptMetadata("quiet-recently", {
      transcriptAppendedHoursAgo: 20,
    });
    await setTranscriptMetadata("passive-good", {
      transcriptAppendedHoursAgo: 20,
    });
    await setTranscriptMetadata("too-short", {
      transcriptAppendedHoursAgo: 20,
    });
    await setTranscriptMetadata("too-noisy", {
      transcriptAppendedHoursAgo: 5,
    });
    await setTranscriptMetadata("already-reflected", {
      transcriptAppendedHoursAgo: 20,
    });

    const candidates =
      await __idleReflectionSweepTestUtils.discoverIdleReflectionCandidates({
        agentId,
        workingDirectory: "/tmp/work",
        reflectionSettings: normalizeReflectionSettings({
          trigger: "step-count",
          stepCount: 25,
          passiveSweepEnabled: true,
          passiveSweepIntervalHours: 24,
          passiveConversationMinIdleHours: 15,
          passiveConversationMinUnreflectedTurns: 3,
        }),
        recompileContext: {
          recompileByConversation: new Map(),
          recompileQueuedByConversation: new Set(),
        },
        now: () => nowMs,
      });

    expect(
      candidates.map((candidate) => candidate.conversationId).sort(),
    ).toEqual(["passive-good", "quiet-recently"]);
  });

  test("skips candidates with active reflection subagents or busy runtimes", async () => {
    await appendCompletedTurns("passive-good", 3);
    await appendCompletedTurns("reflection-active", 3);
    await appendCompletedTurns("runtime-busy", 3);

    await setTranscriptMetadata("passive-good", {
      transcriptAppendedHoursAgo: 20,
    });
    await setTranscriptMetadata("reflection-active", {
      transcriptAppendedHoursAgo: 20,
    });
    await setTranscriptMetadata("runtime-busy", {
      transcriptAppendedHoursAgo: 20,
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
        workingDirectory: "/tmp/work",
        reflectionSettings: normalizeReflectionSettings({
          trigger: "step-count",
          stepCount: 25,
          passiveSweepEnabled: true,
          passiveSweepIntervalHours: 24,
          passiveConversationMinIdleHours: 15,
          passiveConversationMinUnreflectedTurns: 3,
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

  test("multi-candidate sweep runs sequentially through the real launcher, advancing only successful cursors", async () => {
    await appendCompletedTurns("idle-a", 3);
    await appendCompletedTurns("idle-b", 3);
    await appendCompletedTurns("idle-c", 3);
    await setTranscriptMetadata("idle-a", { transcriptAppendedHoursAgo: 20 });
    await setTranscriptMetadata("idle-b", { transcriptAppendedHoursAgo: 20 });
    await setTranscriptMetadata("idle-c", { transcriptAppendedHoursAgo: 20 });

    __autoReflectionTestUtils.resetReflectionQueue();

    const events: string[] = [];
    let activeLaunches = 0;
    let maxActiveLaunches = 0;
    // idle-b's reflection fails — cursor must not advance and aggregate
    // notification must report partial success.
    const successByConv: Record<string, boolean> = {
      "idle-a": true,
      "idle-b": false,
      "idle-c": true,
    };

    const wrappedLaunch = (
      input: LaunchReflectionInput,
    ): Promise<LaunchReflectionResult> =>
      launchReflectionSubagent({
        ...input,
        deps: {
          isMemfsEnabled: () => true,
          getSystemPrompt: async () => undefined,
          spawnBackgroundSubagentTask: ({ onComplete, parentScope }) => {
            const conversationId = parentScope.conversationId;
            events.push(`spawn:${conversationId}`);
            activeLaunches += 1;
            maxActiveLaunches = Math.max(maxActiveLaunches, activeLaunches);
            void Promise.resolve().then(async () => {
              activeLaunches -= 1;
              events.push(`complete:${conversationId}`);
              await onComplete({
                success: successByConv[conversationId] ?? true,
                agentId: `reflection-${conversationId}`,
              });
            });
            return { subagentId: `sub-${conversationId}` };
          },
          waitForBackgroundSubagentAgentId: async () => "reflection-agent-stub",
          handleMemorySubagentCompletion: async () => "reflection complete",
        },
      });

    const notifications: string[] = [];

    await __idleReflectionSweepTestUtils.runIdleReflectionSweep({
      agentId,
      workingDirectory: "/tmp/work",
      reflectionSettings: normalizeReflectionSettings({
        trigger: "step-count",
        stepCount: 25,
        passiveSweepEnabled: true,
        passiveSweepIntervalHours: 24,
        passiveConversationMinIdleHours: 15,
        passiveConversationMinUnreflectedTurns: 3,
      }),
      recompileContext: {
        recompileByConversation: new Map(),
        recompileQueuedByConversation: new Set(),
      },
      launchReflectionSubagent: wrappedLaunch,
      emitCompletionNotification: (message) => {
        notifications.push(message);
      },
      now: () => nowMs,
    });

    expect(maxActiveLaunches).toBe(1);
    expect(events).toEqual([
      "spawn:idle-a",
      "complete:idle-a",
      "spawn:idle-b",
      "complete:idle-b",
      "spawn:idle-c",
      "complete:idle-c",
    ]);
    expect(notifications).toEqual([
      "Idle reflection sweep completed: 2/3 conversation(s) reflected.",
    ]);

    const derivedA = await getReflectionTranscriptDerivedState(
      agentId,
      "idle-a",
    );
    expect(derivedA.state.reflected_completed_turns).toBe(3);
    expect(derivedA.state.last_reflection_source).toBe("idle-time");
    expect(derivedA.hasUnreflectedMessages).toBe(false);

    // Failed reflection leaves cursor and source untouched.
    const derivedB = await getReflectionTranscriptDerivedState(
      agentId,
      "idle-b",
    );
    expect(derivedB.state.reflected_completed_turns).toBe(0);
    expect(derivedB.state.last_reflection_source).toBeUndefined();
    expect(derivedB.hasUnreflectedMessages).toBe(true);

    const derivedC = await getReflectionTranscriptDerivedState(
      agentId,
      "idle-c",
    );
    expect(derivedC.state.reflected_completed_turns).toBe(3);
    expect(derivedC.state.last_reflection_source).toBe("idle-time");
    expect(derivedC.hasUnreflectedMessages).toBe(false);

    const sweepState =
      await __idleReflectionSweepTestUtils.readIdleSweepState(agentId);
    expect(sweepState.last_idle_sweep_started_at).toBeString();
    expect(sweepState.last_idle_sweep_completed_at).toBeString();
  });

  test("scheduler skips when not due", async () => {
    await appendCompletedTurns("idle-good", 3);
    await setTranscriptMetadata("idle-good", {
      transcriptAppendedHoursAgo: 20,
    });
    await __idleReflectionSweepTestUtils.writeIdleSweepState(agentId, {
      last_idle_sweep_started_at: new Date(
        nowMs - 60 * 60 * 1000,
      ).toISOString(),
    });

    let launchCount = 0;
    maybeStartIdleReflectionSweep({
      agentId,
      workingDirectory: "/tmp/work",
      reflectionSettings: normalizeReflectionSettings({
        trigger: "step-count",
        stepCount: 25,
        passiveSweepEnabled: true,
        passiveSweepIntervalHours: 24,
        passiveConversationMinIdleHours: 15,
        passiveConversationMinUnreflectedTurns: 3,
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
      transcriptAppendedHoursAgo: 20,
    });

    let launchCount = 0;
    const sweepInput = {
      agentId,
      workingDirectory: "/tmp/work",
      reflectionSettings: normalizeReflectionSettings({
        trigger: "step-count" as const,
        stepCount: 25,
        passiveSweepEnabled: true,
        passiveSweepIntervalHours: 24,
        passiveConversationMinIdleHours: 15,
        passiveConversationMinUnreflectedTurns: 3,
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

  test("concurrent maybeStartIdleReflectionSweep calls only claim the slot once", async () => {
    await appendCompletedTurns("idle-good", 3);
    await setTranscriptMetadata("idle-good", {
      transcriptAppendedHoursAgo: 20,
    });

    let launchCount = 0;
    const launch = async (): Promise<LaunchReflectionResult> => {
      launchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        status: "completed",
        success: true,
        payloadPath: "/tmp/idle-good.json",
      };
    };

    const settings = normalizeReflectionSettings({
      trigger: "step-count" as const,
      stepCount: 25,
      passiveSweepEnabled: true,
      passiveSweepIntervalHours: 24,
      passiveConversationMinIdleHours: 15,
      passiveConversationMinUnreflectedTurns: 3,
    });

    const buildInput = () => ({
      agentId,
      workingDirectory: "/tmp/work",
      reflectionSettings: settings,
      recompileContext: {
        recompileByConversation: new Map<string, Promise<void>>(),
        recompileQueuedByConversation: new Set<string>(),
      },
      now: () => nowMs,
      launchReflectionSubagent: launch,
    });

    __idleReflectionSweepTestUtils.resetInFlight();
    maybeStartIdleReflectionSweep(buildInput());
    __idleReflectionSweepTestUtils.resetInFlight();
    maybeStartIdleReflectionSweep(buildInput());
    __idleReflectionSweepTestUtils.resetInFlight();
    maybeStartIdleReflectionSweep(buildInput());

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(launchCount).toBe(1);
  });
});
