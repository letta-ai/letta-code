import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createBuffers, toLines } from "@/cli/helpers/accumulator";
import { createContextTracker } from "@/cli/helpers/context-tracker";
import { REFLECTION_STATE_SCHEMA_VERSION } from "@/cli/helpers/reflection-transcript";
import { createSharedReminderState } from "@/reminders/state";
import { __listenerTurnTestUtils } from "@/websocket/listener/turn";

describe("post-turn channel reflection", () => {
  test("seeds inbound websocket user rows into the reflection transcript buffer", () => {
    const lines = __listenerTurnTestUtils.buildInboundUserTranscriptLines([
      {
        role: "user",
        content: "remember this",
        otid: "client-message-1",
      },
    ]);
    const buffers = createBuffers("agent-1");

    __listenerTurnTestUtils.seedInboundUserTranscriptLines(buffers, lines);

    expect(toLines(buffers)).toEqual([
      {
        kind: "user",
        id: "user-client-message-1",
        text: "remember this",
        otid: "client-message-1",
      },
    ]);
    expect(buffers.userLineIdByOtid.get("client-message-1")).toBe(
      "user-client-message-1",
    );
  });

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

  test("records listener transcript rows before evaluating post-turn reflection", () => {
    const turnPath = fileURLToPath(new URL("./turn.ts", import.meta.url));
    const source = readFileSync(turnPath, "utf-8");
    const endTurnIndex = source.indexOf('if (stopReason === "end_turn")');
    const appendIndex = source.indexOf(
      "appendTranscriptDeltaJsonl(",
      endTurnIndex,
    );
    const launchIndex = source.indexOf(
      "maybeLaunchPostTurnChannelReflection({",
      endTurnIndex,
    );

    expect(endTurnIndex).toBeGreaterThanOrEqual(0);
    expect(appendIndex).toBeGreaterThan(endTurnIndex);
    expect(launchIndex).toBeGreaterThan(appendIndex);
  });
});
