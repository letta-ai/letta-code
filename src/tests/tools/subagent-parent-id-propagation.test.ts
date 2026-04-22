import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SubagentState } from "../../cli/helpers/subagentState";
import { clearAllSubagents } from "../../cli/helpers/subagentState";
import {
  __resetBackgroundRetentionConfigForTests,
  backgroundTasks,
} from "../../tools/impl/process_manager";
import { spawnBackgroundSubagentTask } from "../../tools/impl/Task";

/**
 * Covers the fix for the async-drift race where `executeSubagent` inside
 * `spawnSubagent` re-derives parentAgentId from getCurrentAgentId() after
 * multiple async yields — by which point the listener's in-process agent
 * context may have changed. The fix is to capture parentAgentId
 * synchronously at the call site (from parentScope.agentId) and plumb it
 * through as the 10th positional arg to spawnSubagent.
 *
 * Verifying at the spawnBackgroundSubagentTask boundary: whatever
 * parentScope.agentId callers pass in MUST reach the spawnSubagentImpl
 * as its parentAgentId argument — not re-read from a global context.
 */

describe("parentScope.agentId propagation to spawnSubagent", () => {
  const PARENT_AGENT_ID = "agent-parent-abc123";
  let subagentCounter = 0;

  const generateSubagentIdImpl = () => {
    subagentCounter += 1;
    return `subagent-test-${subagentCounter}`;
  };

  const registerSubagentImpl = mock(() => {});
  const completeSubagentImpl = mock(() => {});
  const addToMessageQueueImpl = () => {};
  const formatTaskNotificationImpl = mock(() => "<task-notification/>");
  const runSubagentStopHooksImpl = mock(async () => ({
    blocked: false,
    errored: false,
    feedback: [],
    results: [],
  }));

  const buildSnapshot = (id: string): SubagentState => ({
    id,
    type: "Reflection",
    description: "Test",
    status: "running",
    agentURL: null,
    toolCalls: [],
    maxToolCallsSeen: 0,
    totalTokens: 0,
    durationMs: 0,
    startTime: Date.now(),
  });
  const getSubagentSnapshotImpl = () => ({
    agents: [buildSnapshot("subagent-test-1")],
    expanded: false,
  });

  beforeEach(() => {
    subagentCounter = 0;
    registerSubagentImpl.mockClear();
    completeSubagentImpl.mockClear();
    formatTaskNotificationImpl.mockClear();
    runSubagentStopHooksImpl.mockClear();
    __resetBackgroundRetentionConfigForTests();
    backgroundTasks.clear();
    clearAllSubagents();
  });

  afterEach(() => {
    __resetBackgroundRetentionConfigForTests();
    backgroundTasks.clear();
    clearAllSubagents();
  });

  // Positional args of spawnSubagent:
  //   0: type, 1: prompt, 2: userModel, 3: subagentId, 4: signal,
  //   5: existingAgentId, 6: existingConversationId, 7: maxTurns,
  //   8: forkedContext, 9: parentAgentId   ← the one we care about
  const PARENT_ID_ARG_INDEX = 9;

  // Typed stub matching spawnSubagent's shape so mock.calls is inferred
  // as a tuple with the 10th element addressable.
  type SpawnArgs = [
    type: string,
    prompt: string,
    userModel: string | undefined,
    subagentId: string,
    signal?: AbortSignal,
    existingAgentId?: string,
    existingConversationId?: string,
    maxTurns?: number,
    forkedContext?: boolean,
    parentAgentId?: string,
  ];

  const makeSpawnStub = () =>
    mock(
      async (
        ..._args: SpawnArgs
      ): Promise<{
        agentId: string;
        conversationId: string;
        report: string;
        success: boolean;
        totalTokens: number;
      }> => ({
        agentId: "agent-child",
        conversationId: "default",
        report: "ok",
        success: true,
        totalTokens: 0,
      }),
    );

  test("forwards parentScope.agentId as 10th positional arg to spawnSubagent", async () => {
    const spawnSubagentImpl = makeSpawnStub();

    spawnBackgroundSubagentTask({
      subagentType: "reflection",
      prompt: "Reflect",
      description: "Test",
      parentScope: { agentId: PARENT_AGENT_ID, conversationId: "conv-xyz" },
      deps: {
        spawnSubagentImpl,
        addToMessageQueueImpl,
        formatTaskNotificationImpl,
        runSubagentStopHooksImpl,
        generateSubagentIdImpl,
        registerSubagentImpl,
        completeSubagentImpl,
        getSubagentSnapshotImpl,
      },
    });

    // fire-and-forget — give the microtask queue a tick
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spawnSubagentImpl).toHaveBeenCalledTimes(1);
    const call = spawnSubagentImpl.mock.calls[0] as SpawnArgs | undefined;
    expect(call).toBeDefined();
    expect(call?.[PARENT_ID_ARG_INDEX]).toBe(PARENT_AGENT_ID);
  });

  test("forwards undefined parentAgentId when parentScope is omitted", async () => {
    const spawnSubagentImpl = makeSpawnStub();

    spawnBackgroundSubagentTask({
      subagentType: "reflection",
      prompt: "Reflect",
      description: "Test",
      // No parentScope — simulates legacy callers pre-fix
      deps: {
        spawnSubagentImpl,
        addToMessageQueueImpl,
        formatTaskNotificationImpl,
        runSubagentStopHooksImpl,
        generateSubagentIdImpl,
        registerSubagentImpl,
        completeSubagentImpl,
        getSubagentSnapshotImpl,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spawnSubagentImpl).toHaveBeenCalledTimes(1);
    const call = spawnSubagentImpl.mock.calls[0] as SpawnArgs | undefined;
    expect(call).toBeDefined();
    // spawnSubagent will fall back to getCurrentAgentId() internally; at
    // this layer we just confirm that without parentScope, nothing is
    // forwarded (so fallback will be exercised).
    expect(call?.[PARENT_ID_ARG_INDEX]).toBeUndefined();
  });
});
