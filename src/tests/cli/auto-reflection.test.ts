import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __autoReflectionTestUtils,
  launchReflectionSubagent,
} from "../../cli/helpers/autoReflection";
import {
  appendTranscriptDeltaJsonl,
  getReflectionTranscriptDerivedState,
} from "../../cli/helpers/reflectionTranscript";

describe("auto reflection launcher serialization", () => {
  afterEach(() => {
    __autoReflectionTestUtils.resetReflectionQueue();
  });

  test("serializes reflection work for the same parent agent", async () => {
    const events: string[] = [];
    let activeCount = 0;
    let maxActiveCount = 0;

    const makeLaunch = (id: string) => async () => {
      events.push(`start:${id}`);
      activeCount += 1;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeCount -= 1;
      events.push(`end:${id}`);
      return id;
    };

    const first = __autoReflectionTestUtils.enqueueReflectionForAgent(
      "agent-same",
      makeLaunch("first"),
    );
    const second = __autoReflectionTestUtils.enqueueReflectionForAgent(
      "agent-same",
      makeLaunch("second"),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ]);
    expect(maxActiveCount).toBe(1);
    expect(events).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
    ]);
  });

  test("runs queued manual reflection before queued idle reflection", async () => {
    const events: string[] = [];
    let releaseFirst = () => {};
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const first = __autoReflectionTestUtils.enqueueReflectionForAgent(
      "agent-priority",
      async () => {
        events.push("start:first");
        markFirstStarted();
        await firstCanFinish;
        events.push("end:first");
        return "first";
      },
      __autoReflectionTestUtils.queuePriority.active,
    );
    await firstStarted;

    const idle = __autoReflectionTestUtils.enqueueReflectionForAgent(
      "agent-priority",
      async () => {
        events.push("start:idle");
        events.push("end:idle");
        return "idle";
      },
      __autoReflectionTestUtils.queuePriority.idle,
    );
    const manual = __autoReflectionTestUtils.enqueueReflectionForAgent(
      "agent-priority",
      async () => {
        events.push("start:manual");
        events.push("end:manual");
        return "manual";
      },
      __autoReflectionTestUtils.queuePriority.manual,
    );

    releaseFirst();

    await expect(Promise.all([first, idle, manual])).resolves.toEqual([
      "first",
      "idle",
      "manual",
    ]);
    expect(events).toEqual([
      "start:first",
      "end:first",
      "start:manual",
      "end:manual",
      "start:idle",
      "end:idle",
    ]);
  });

  test("does not serialize reflection work across different agents", async () => {
    let releaseFirst = () => {};
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted = () => {};
    const firstDidStart = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let firstAgentActive = false;
    let overlapped = false;

    const first = __autoReflectionTestUtils.enqueueReflectionForAgent(
      "agent-one",
      async () => {
        firstAgentActive = true;
        firstStarted();
        await firstCanFinish;
        firstAgentActive = false;
        return "first";
      },
    );
    await firstDidStart;

    const second = __autoReflectionTestUtils.enqueueReflectionForAgent(
      "agent-two",
      async () => {
        overlapped = firstAgentActive;
        return "second";
      },
    );

    await expect(second).resolves.toBe("second");
    releaseFirst();
    await expect(first).resolves.toBe("first");
    expect(overlapped).toBe(true);
  });
});

describe("auto reflection launcher behavior", () => {
  const agentId = "agent-auto-reflection";
  const conversationId = "conv-auto-reflection";
  let testRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "letta-auto-reflection-test-"));
    process.env.LETTA_TRANSCRIPT_ROOT = testRoot;
  });

  afterEach(async () => {
    delete process.env.LETTA_TRANSCRIPT_ROOT;
    __autoReflectionTestUtils.resetReflectionQueue();
    await rm(testRoot, { recursive: true, force: true });
  });

  function baseInput() {
    return {
      agentId,
      conversationId,
      workingDirectory: "/tmp/work",
      triggerSource: "manual" as const,
      recompileContext: {
        recompileByConversation: new Map<string, Promise<void>>(),
        recompileQueuedByConversation: new Set<string>(),
      },
    };
  }

  test("waitUntil launched reports no transcript delta as a skip", async () => {
    const result = await launchReflectionSubagent({
      ...baseInput(),
      waitUntil: "launched",
      deps: {
        isMemfsEnabled: () => true,
        getSystemPrompt: async () => undefined,
      },
    });

    expect(result).toEqual({
      status: "skipped",
      skippedReason: "no-transcript-delta",
    });
  });

  test("successful subagent completion advances the shared cursor", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "remember this", messageId: "msg-u1" },
      {
        kind: "assistant",
        id: "a1",
        text: "noted",
        phase: "finished",
        messageId: "msg-a1",
      },
    ]);

    let onComplete:
      | ((result: {
          success: boolean;
          error?: string;
          agentId?: string;
          conversationId?: string;
        }) => void | Promise<void>)
      | undefined;
    const notifications: string[] = [];
    const result = await launchReflectionSubagent({
      ...baseInput(),
      waitUntil: "launched",
      emitCompletionNotification: (message) => {
        notifications.push(message);
      },
      deps: {
        isMemfsEnabled: () => true,
        getSystemPrompt: async () => "system prompt",
        spawnBackgroundSubagentTask: (input) => {
          onComplete = input.onComplete;
          return { subagentId: "subagent-reflection" };
        },
        waitForBackgroundSubagentAgentId: async () => "reflection-agent",
        handleMemorySubagentCompletion: async () => "reflection complete",
      },
    });

    expect(result.status).toBe("launched");
    expect(onComplete).toBeFunction();
    await onComplete?.({ success: true, agentId: "reflection-agent" });

    const derived = await getReflectionTranscriptDerivedState(
      agentId,
      conversationId,
    );
    expect(derived.hasUnreflectedMessages).toBe(false);
    expect(derived.state.turns_since_last_successful_reflection).toBe(0);
    expect(derived.state.last_reflection_source).toBe("manual");
    expect(notifications).toEqual(["reflection complete"]);
  });

  test("failed subagent completion leaves cursor and cadence state unchanged", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "remember this", messageId: "msg-u1" },
    ]);

    let onComplete:
      | ((result: {
          success: boolean;
          error?: string;
          agentId?: string;
          conversationId?: string;
        }) => void | Promise<void>)
      | undefined;
    const result = await launchReflectionSubagent({
      ...baseInput(),
      waitUntil: "launched",
      deps: {
        isMemfsEnabled: () => true,
        getSystemPrompt: async () => undefined,
        spawnBackgroundSubagentTask: (input) => {
          onComplete = input.onComplete;
          return { subagentId: "subagent-reflection" };
        },
        waitForBackgroundSubagentAgentId: async () => "reflection-agent",
        handleMemorySubagentCompletion: async () => "reflection failed",
      },
    });

    expect(result.status).toBe("launched");
    await onComplete?.({
      success: false,
      error: "boom",
      agentId: "reflection-agent",
    });

    const derived = await getReflectionTranscriptDerivedState(
      agentId,
      conversationId,
    );
    expect(derived.hasUnreflectedMessages).toBe(true);
    expect(derived.state.reflected_through_message_id).toBeUndefined();
    expect(derived.state.turns_since_last_successful_reflection).toBe(1);
  });
});
