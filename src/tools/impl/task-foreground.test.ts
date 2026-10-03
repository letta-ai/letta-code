import { describe, expect, test } from "bun:test";
import type { SubagentResult } from "@/agent/subagents";
import { spawnBackgroundSubagentTask } from "@/tools/impl/task";
import {
  type LaunchSubagent,
  runForegroundTask,
} from "@/tools/impl/task-foreground";
import type { QueuedMessage } from "@/utils/message-queue-bridge";

function harness() {
  const queued: QueuedMessage[] = [];
  let finishChild: (result: SubagentResult) => void = () => {};
  let childSignal: AbortSignal | undefined;
  let counter = 0;
  const launch: LaunchSubagent<{ signal?: AbortSignal }> = async (
    args,
    options,
  ) => {
    void args;
    const { taskId, outputFile } = spawnBackgroundSubagentTask({
      subagentType: "general-purpose",
      prompt: "nested work",
      description: "Nested child",
      parentScope: { agentId: "agent-child", conversationId: "conv-child" },
      onComplete: options.onComplete,
      emitCompletionNotification: false,
      deps: {
        spawnSubagentImpl: async (_t, _p, _m, _id, signal) => {
          childSignal = signal;
          return new Promise<SubagentResult>((resolve) => {
            finishChild = resolve;
            signal?.addEventListener("abort", () =>
              resolve({ agentId: "", report: "", success: false, error: "x" }),
            );
          });
        },
        copyGitHubPullRequestTagsImpl: async () => {},
        addToMessageQueueImpl: (message) => queued.push(message),
        runSubagentStopHooksImpl: async () => ({
          blocked: false,
          errored: false,
          feedback: [],
          results: [],
        }),
        generateSubagentIdImpl: () => `subagent-foreground-${++counter}`,
        registerSubagentImpl: () => {},
        completeSubagentImpl: () => {},
        getSubagentSnapshotImpl: () => ({ agents: [], expanded: false }),
      },
    });
    return {
      success: true as const,
      task_id: taskId,
      output_file: outputFile,
      agent_id: "agent-grandchild",
      conversation_id: "conv-grandchild",
    };
  };
  return {
    queued,
    launch,
    finish: (result: SubagentResult) => finishChild(result),
    childSignal: () => childSignal,
  };
}

describe("foreground Agent calls from a subagent", () => {
  test("return the nested child's report only after it finishes, with no later notification", async () => {
    const h = harness();
    let settled = false;
    const call = runForegroundTask({}, h.launch).then((text) => {
      settled = true;
      return text;
    });
    await Bun.sleep(20);
    expect(settled).toBe(false);

    h.finish({
      agentId: "agent-grandchild",
      conversationId: "conv-grandchild",
      report: "nested report",
      success: true,
    });
    const text = await call;
    expect(text).toContain("Agent completed");
    expect(text).toContain("Conversation ID: conv-grandchild");
    expect(text).toContain("nested report");
    await Bun.sleep(10);
    expect(h.queued).toEqual([]);
  });

  test("interrupting the parent call stops the nested child", async () => {
    const h = harness();
    const controller = new AbortController();
    const call = runForegroundTask({ signal: controller.signal }, h.launch);
    await Bun.sleep(10);
    controller.abort();
    expect(h.childSignal()?.aborted).toBe(true);
    expect(await call).toContain("Agent failed");
  });
});
