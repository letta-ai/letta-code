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
  ): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await appendTranscriptDeltaJsonl(agentId, conversationId, [
        {
          kind: "user",
          id: `${conversationId}-u${index}`,
          text: `user ${index}`,
          messageId: `${conversationId}-msg-u${index}`,
        },
        {
          kind: "assistant",
          id: `${conversationId}-a${index}`,
          text: `assistant ${index}`,
          phase: "finished",
          messageId: `${conversationId}-msg-a${index}`,
        },
      ]);
    }
  }

  async function ageTranscript(conversationId: string, hoursAgo: number) {
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    const state = JSON.parse(await readFile(paths.statePath, "utf-8")) as {
      last_transcript_appended_at?: string;
    };
    state.last_transcript_appended_at = new Date(
      Date.now() - hoursAgo * 60 * 60 * 1000,
    ).toISOString();
    await writeFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  test("filters local idle candidates by active conversation, age, turns, and cursor", async () => {
    await appendCompletedTurns("active", 3);
    await appendCompletedTurns("idle-good", 3);
    await appendCompletedTurns("too-short", 2);
    await appendCompletedTurns("too-new", 3);
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

    await ageTranscript("active", 25);
    await ageTranscript("idle-good", 25);
    await ageTranscript("too-short", 25);
    await ageTranscript("too-new", 1);
    await ageTranscript("already-reflected", 25);

    const candidates =
      await __idleReflectionSweepTestUtils.discoverIdleReflectionCandidates({
        agentId,
        activeConversationId: "active",
        workingDirectory: "/tmp/work",
        reflectionSettings: normalizeReflectionSettings({
          trigger: "step-count",
          stepCount: 25,
          idleSweepEnabled: true,
          idleSweepIntervalHours: 24,
          idleConversationMinAgeHours: 24,
          idleMinUnreflectedTurns: 3,
        }),
        recompileContext: {
          recompileByConversation: new Map(),
          recompileQueuedByConversation: new Set(),
        },
      });

    expect(candidates.map((candidate) => candidate.conversationId)).toEqual([
      "idle-good",
    ]);
  });

  test("skips candidates with active reflection subagents or busy runtimes", async () => {
    await appendCompletedTurns("idle-good", 3);
    await appendCompletedTurns("reflection-active", 3);
    await appendCompletedTurns("runtime-busy", 3);

    await ageTranscript("idle-good", 25);
    await ageTranscript("reflection-active", 25);
    await ageTranscript("runtime-busy", 25);

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
          idleSweepEnabled: true,
          idleSweepIntervalHours: 24,
          idleConversationMinAgeHours: 24,
          idleMinUnreflectedTurns: 3,
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
      });

    expect(candidates.map((candidate) => candidate.conversationId)).toEqual([
      "idle-good",
    ]);
  });

  test("sweep processes candidates sequentially and emits one aggregate notification", async () => {
    await appendCompletedTurns("idle-a", 3);
    await appendCompletedTurns("idle-b", 3);
    await appendCompletedTurns("idle-c", 3);
    await ageTranscript("idle-a", 25);
    await ageTranscript("idle-b", 25);
    await ageTranscript("idle-c", 25);

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
        idleSweepEnabled: true,
        idleSweepIntervalHours: 24,
        idleConversationMinAgeHours: 24,
        idleMinUnreflectedTurns: 3,
      }),
      recompileContext: {
        recompileByConversation: new Map(),
        recompileQueuedByConversation: new Set(),
      },
      launchReflectionSubagent: launch,
      emitCompletionNotification: (message) => {
        notifications.push(message);
      },
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
    await ageTranscript("idle-good", 25);

    const nowMs = Date.parse("2026-04-24T12:00:00.000Z");
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
        idleSweepEnabled: true,
        idleSweepIntervalHours: 24,
        idleConversationMinAgeHours: 24,
        idleMinUnreflectedTurns: 3,
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
});
