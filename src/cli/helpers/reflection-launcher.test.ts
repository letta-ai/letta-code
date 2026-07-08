import { describe, expect, mock, test } from "bun:test";
import {
  type ReflectionLaunchOptions,
  shouldRunQueuedReflectionLaunch,
} from "@/cli/helpers/reflection-launcher";
import {
  REFLECTION_STATE_SCHEMA_VERSION,
  type ReflectionTranscriptState,
} from "@/cli/helpers/reflection-transcript";

function queuedLaunchOptions(
  overrides: Partial<ReflectionLaunchOptions> = {},
): ReflectionLaunchOptions {
  return {
    agentId: "agent-1",
    conversationId: "conv-1",
    memfsEnabled: true,
    triggerSource: "step-count",
    reflectionSettings: { trigger: "step-count", stepCount: 25 },
    description: "Reflect on recent conversations",
    recompileByConversation: new Map(),
    recompileQueuedByConversation: new Set(),
    ...overrides,
  };
}

function transcriptState(
  stepsSinceLastSuccessfulReflection: number,
): ReflectionTranscriptState {
  return {
    schema_version: REFLECTION_STATE_SCHEMA_VERSION,
    total_completed_steps: stepsSinceLastSuccessfulReflection,
    reflected_completed_steps: 0,
    steps_since_last_successful_reflection: stepsSinceLastSuccessfulReflection,
  };
}

describe("shouldRunQueuedReflectionLaunch", () => {
  test("skips queued step-count launches when the threshold is no longer met", async () => {
    const getTranscriptState = mock(async () => transcriptState(1));

    const shouldRun = await shouldRunQueuedReflectionLaunch(
      queuedLaunchOptions(),
      { getTranscriptState },
    );

    expect(shouldRun).toBe(false);
    expect(getTranscriptState).toHaveBeenCalledWith("agent-1", "conv-1");
  });

  test("runs queued step-count launches when the threshold is still met", async () => {
    const getTranscriptState = mock(async () => transcriptState(25));

    const shouldRun = await shouldRunQueuedReflectionLaunch(
      queuedLaunchOptions(),
      { getTranscriptState },
    );

    expect(shouldRun).toBe(true);
  });

  test("does not re-check non-step-count queued launches", async () => {
    const getTranscriptState = mock(async () => transcriptState(0));

    const shouldRun = await shouldRunQueuedReflectionLaunch(
      queuedLaunchOptions({ triggerSource: "compaction-event" }),
      { getTranscriptState },
    );

    expect(shouldRun).toBe(true);
    expect(getTranscriptState).not.toHaveBeenCalled();
  });
});
