import { describe, expect, mock, test } from "bun:test";
import { createContextTracker } from "@/cli/helpers/context-tracker";
import { REFLECTION_STATE_SCHEMA_VERSION } from "@/cli/helpers/reflection-transcript";
import { createSharedReminderState } from "@/reminders/state";
import { __listenerTurnTestUtils } from "@/websocket/listener/turn";

describe("post-turn channel reflection", () => {
  test("launches step-count reflection after a channel turn reaches the transcript threshold", async () => {
    const launches: string[] = [];

    const didLaunch =
      await __listenerTurnTestUtils.maybeLaunchPostTurnChannelReflection({
        hasChannelTurnSources: true,
        agentId: "agent-1",
        conversationId: "conv-slack-thread",
        memfsEnabled: true,
        reflectionSettings: { trigger: "step-count", stepCount: 3 },
        reminderState: createSharedReminderState(),
        contextTracker: createContextTracker(),
        getTranscriptState: mock(async () => ({
          schema_version: REFLECTION_STATE_SCHEMA_VERSION,
          total_completed_turns: 3,
          reflected_completed_turns: 0,
          turns_since_last_successful_reflection: 3,
        })),
        launch: mock(async (trigger) => {
          launches.push(trigger);
          return true;
        }),
      });

    expect(didLaunch).toBe(true);
    expect(launches).toEqual(["step-count"]);
  });

  test("launches compaction reflection after a channel turn marks compaction complete", async () => {
    const reminderState = createSharedReminderState();
    const contextTracker = createContextTracker();
    contextTracker.pendingReflectionTrigger = true;
    const launches: string[] = [];

    const didLaunch =
      await __listenerTurnTestUtils.maybeLaunchPostTurnChannelReflection({
        hasChannelTurnSources: true,
        agentId: "agent-1",
        conversationId: "conv-slack-thread",
        memfsEnabled: true,
        reflectionSettings: { trigger: "compaction-event", stepCount: 25 },
        reminderState,
        contextTracker,
        launch: mock(async (trigger) => {
          launches.push(trigger);
          return true;
        }),
      });

    expect(didLaunch).toBe(true);
    expect(launches).toEqual(["compaction-event"]);
    expect(contextTracker.pendingReflectionTrigger).toBe(false);
    expect(reminderState.pendingReflectionTrigger).toBe(false);
  });

  test("ignores non-channel turns so interactive behavior stays unchanged", async () => {
    const launch = mock(async () => true);

    const didLaunch =
      await __listenerTurnTestUtils.maybeLaunchPostTurnChannelReflection({
        hasChannelTurnSources: false,
        agentId: "agent-1",
        conversationId: "conv-1",
        memfsEnabled: true,
        reflectionSettings: { trigger: "step-count", stepCount: 1 },
        reminderState: createSharedReminderState(),
        contextTracker: createContextTracker(),
        getTranscriptState: mock(async () => ({
          schema_version: REFLECTION_STATE_SCHEMA_VERSION,
          total_completed_turns: 1,
          reflected_completed_turns: 0,
          turns_since_last_successful_reflection: 1,
        })),
        launch,
      });

    expect(didLaunch).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });
});
