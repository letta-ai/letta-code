import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContextTracker } from "@/cli/helpers/context-tracker";
import { maybeLaunchPostTurnReflection } from "@/cli/helpers/post-turn-reflection";
import {
  appendTranscriptDeltaJsonl,
  REFLECTION_STATE_SCHEMA_VERSION,
} from "@/cli/helpers/reflection-transcript";
import { createSharedReminderState } from "@/reminders/state";

function transcriptStateWith(stepsSinceLastReflection: number) {
  return mock(async () => ({
    schema_version: REFLECTION_STATE_SCHEMA_VERSION,
    total_completed_steps: stepsSinceLastReflection,
    reflected_completed_steps: 0,
    steps_since_last_successful_reflection: stepsSinceLastReflection,
  }));
}

describe("maybeLaunchPostTurnReflection", () => {
  test("launches step-count reflection when the transcript threshold is reached", async () => {
    const launches: string[] = [];

    const didLaunch = await maybeLaunchPostTurnReflection({
      agentId: "agent-1",
      conversationId: "conv-1",
      memfsEnabled: true,
      reflectionSettings: { trigger: "step-count", stepCount: 3 },
      reminderState: createSharedReminderState(),
      contextTracker: createContextTracker(),
      getTranscriptState: transcriptStateWith(3),
      launch: mock(async (trigger) => {
        launches.push(trigger);
        return true;
      }),
    });

    expect(didLaunch).toBe(true);
    expect(launches).toEqual(["step-count"]);
  });

  test("does not launch step-count reflection below the threshold", async () => {
    const launch = mock(async () => true);

    const didLaunch = await maybeLaunchPostTurnReflection({
      agentId: "agent-1",
      conversationId: "conv-1",
      memfsEnabled: true,
      reflectionSettings: { trigger: "step-count", stepCount: 3 },
      reminderState: createSharedReminderState(),
      contextTracker: createContextTracker(),
      getTranscriptState: transcriptStateWith(2),
      launch,
    });

    expect(didLaunch).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  test("runs compaction maintenance even when reflection trigger is step-count", async () => {
    const launch = mock(async () => true);
    const onCompaction = mock(async () => {});
    const contextTracker = createContextTracker();
    const reminderState = createSharedReminderState();
    contextTracker.pendingReflectionTrigger = true;

    const didLaunch = await maybeLaunchPostTurnReflection({
      agentId: "agent-1",
      conversationId: "conv-1",
      memfsEnabled: true,
      reflectionSettings: { trigger: "step-count", stepCount: 3 },
      reminderState,
      contextTracker,
      getTranscriptState: transcriptStateWith(2),
      launch,
      onCompaction,
    });

    expect(didLaunch).toBe(false);
    expect(onCompaction).toHaveBeenCalledTimes(1);
    expect(contextTracker.pendingReflectionTrigger).toBe(false);
    expect(reminderState.pendingReflectionTrigger).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  test("launches compaction reflection when a compaction event is pending and consumes the flag", async () => {
    const reminderState = createSharedReminderState();
    const contextTracker = createContextTracker();
    contextTracker.pendingReflectionTrigger = true;
    const onCompaction = mock(async () => {});
    const launches: string[] = [];

    const didLaunch = await maybeLaunchPostTurnReflection({
      agentId: "agent-1",
      conversationId: "conv-1",
      memfsEnabled: true,
      reflectionSettings: { trigger: "compaction-event", stepCount: 25 },
      reminderState,
      contextTracker,
      launch: mock(async (trigger) => {
        launches.push(trigger);
        return true;
      }),
      onCompaction,
    });

    expect(didLaunch).toBe(true);
    expect(onCompaction).toHaveBeenCalledTimes(1);
    expect(launches).toEqual(["compaction-event"]);
    expect(contextTracker.pendingReflectionTrigger).toBe(false);
    expect(reminderState.pendingReflectionTrigger).toBe(false);
  });

  test("does not launch compaction reflection without a pending compaction event", async () => {
    const launch = mock(async () => true);

    const didLaunch = await maybeLaunchPostTurnReflection({
      agentId: "agent-1",
      conversationId: "conv-1",
      memfsEnabled: true,
      reflectionSettings: { trigger: "compaction-event", stepCount: 25 },
      reminderState: createSharedReminderState(),
      contextTracker: createContextTracker(),
      launch,
    });

    expect(didLaunch).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  test("never launches when the trigger is off", async () => {
    const launch = mock(async () => true);
    const contextTracker = createContextTracker();
    contextTracker.pendingReflectionTrigger = true;

    const didLaunch = await maybeLaunchPostTurnReflection({
      agentId: "agent-1",
      conversationId: "conv-1",
      memfsEnabled: true,
      reflectionSettings: { trigger: "off", stepCount: 1 },
      reminderState: createSharedReminderState(),
      contextTracker,
      getTranscriptState: transcriptStateWith(10),
      launch,
    });

    expect(didLaunch).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  test("never launches when memfs is disabled", async () => {
    const launch = mock(async () => true);

    const didLaunch = await maybeLaunchPostTurnReflection({
      agentId: "agent-1",
      conversationId: "conv-1",
      memfsEnabled: false,
      reflectionSettings: { trigger: "step-count", stepCount: 1 },
      reminderState: createSharedReminderState(),
      contextTracker: createContextTracker(),
      getTranscriptState: transcriptStateWith(10),
      launch,
    });

    expect(didLaunch).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  test("never launches without an agent id", async () => {
    const launch = mock(async () => true);

    const didLaunch = await maybeLaunchPostTurnReflection({
      agentId: null,
      conversationId: "conv-1",
      memfsEnabled: true,
      reflectionSettings: { trigger: "step-count", stepCount: 1 },
      reminderState: createSharedReminderState(),
      contextTracker: createContextTracker(),
      getTranscriptState: transcriptStateWith(10),
      launch,
    });

    expect(didLaunch).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  test("reads step counts from the real transcript state", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "letta-post-turn-test-"));
    const previousRoot = process.env.LETTA_TRANSCRIPT_ROOT;
    process.env.LETTA_TRANSCRIPT_ROOT = testRoot;
    const agentId = "post-turn-agent";
    const conversationId = "post-turn-conversation";
    try {
      const launches: string[] = [];
      const params = {
        agentId,
        conversationId,
        memfsEnabled: true,
        reflectionSettings: { trigger: "step-count", stepCount: 2 } as const,
        reminderState: createSharedReminderState(),
        contextTracker: createContextTracker(),
        launch: mock(async (trigger: string) => {
          launches.push(trigger);
          return true;
        }),
      };

      // No completed turns recorded yet — below threshold.
      expect(await maybeLaunchPostTurnReflection(params)).toBe(false);

      for (let index = 0; index < 2; index += 1) {
        await appendTranscriptDeltaJsonl(agentId, conversationId, [
          {
            kind: "user",
            id: `u${index}`,
            text: `turn ${index}`,
            messageId: `msg-u${index}`,
          },
          {
            kind: "assistant",
            id: `a${index}`,
            text: `response ${index}`,
            phase: "finished",
            messageId: `msg-a${index}`,
          },
        ]);
      }

      expect(await maybeLaunchPostTurnReflection(params)).toBe(true);
      expect(launches).toEqual(["step-count"]);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.LETTA_TRANSCRIPT_ROOT;
      } else {
        process.env.LETTA_TRANSCRIPT_ROOT = previousRoot;
      }
      await rm(testRoot, { recursive: true, force: true });
    }
  });
});
