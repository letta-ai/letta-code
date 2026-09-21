import { describe, expect, test } from "bun:test";
import { spawnBackgroundSubagentTask } from "./task";

describe("spawnBackgroundSubagentTask environment threading", () => {
  test("passes the environment selector through to spawnSubagent", async () => {
    let receivedEnvironment: string | undefined;
    let resolveSpawn: (() => void) | undefined;
    const spawnCalled = new Promise<void>((resolve) => {
      resolveSpawn = resolve;
    });

    spawnBackgroundSubagentTask({
      subagentType: "general-purpose",
      prompt: "do the thing",
      description: "remote task",
      model: undefined,
      environment: "office-mac",
      silentCompletion: true,
      deps: {
        generateSubagentIdImpl: () => "subagent-test-env",
        registerSubagentImpl: () => {},
        completeSubagentImpl: () => {},
        getSubagentSnapshotImpl: () => ({ agents: [], expanded: false }),
        copyGitHubPullRequestTagsImpl: async () => {},
        addToMessageQueueImpl: () => {},
        formatTaskNotificationImpl: () => "",
        runSubagentStopHooksImpl: async () => ({
          blocked: false,
          errored: false,
          feedback: [],
          results: [],
        }),
        spawnSubagentImpl: async (...spawnArgs) => {
          receivedEnvironment = spawnArgs[14];
          resolveSpawn?.();
          return {
            agentId: "agent-remote",
            report: "done",
            success: true,
          };
        },
      },
    });

    await spawnCalled;
    expect(receivedEnvironment).toBe("office-mac");
  });
});
