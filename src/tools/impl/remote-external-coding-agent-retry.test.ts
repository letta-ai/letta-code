import { afterEach, beforeAll, expect, test } from "bun:test";
import { clearAllSubagents } from "@/agent/subagent-state";
import type { EnvironmentConnection } from "@/backend/api/environments";
import { settingsManager } from "@/settings-manager";
import { FakeComputer } from "@/test-utils/remote-worker-computer";
import type { QueuedMessage } from "@/utils/message-queue-bridge";
import { backgroundTasks } from "./process_manager";
import {
  launchRemoteExternalCodingAgent,
  type SpawnRemoteFollowTask,
} from "./remote-external-coding-agent";
import { spawnBackgroundSubagentTask } from "./task";

const scope = { agentId: "agent-parent", conversationId: "conv-parent" };
const accepted = {
  success: true as const,
  task_id: "remote-task",
  output_file: "/remote/out",
  agent_id: "claude_session",
  conversation_id: null,
};

function environment(): EnvironmentConnection {
  return {
    id: "env-1",
    connectionId: "conn-1",
    deviceId: "device-1",
    connectionName: "worker",
    organizationId: "org-1",
    podId: "pod-1",
    connectedAt: 1,
    lastHeartbeat: Date.now(),
    lastSeenAt: 1,
    firstSeenAt: 1,
    metadata: { launch_subagent_notify_caller: true },
  };
}

const queued: QueuedMessage[] = [];

const spawn: SpawnRemoteFollowTask = (args) =>
  spawnBackgroundSubagentTask({
    ...args,
    deps: {
      ...args.deps,
      addToMessageQueueImpl: (message) => queued.push(message),
      copyGitHubPullRequestTagsImpl: async () => {},
      runSubagentStopHooksImpl: async () => ({
        blocked: false,
        errored: false,
        feedback: [],
        results: [],
      }),
    },
  });

function launch(computers: FakeComputer[]) {
  let connects = 0;
  return launchRemoteExternalCodingAgent(
    {
      type: "claude-code",
      computer: "worker",
      prompt: "Fix the bug",
      description: "Fix the bug",
      toolCallId: "call-1",
      parentScope: scope,
    },
    {
      spawn,
      reconnectDelayMs: 1,
      resolveComputer: async () => ({
        connectionId: "conn-1",
        environment: environment(),
      }),
      connect: async () => {
        const computer = computers[connects++];
        if (!computer) throw new Error("no more computers");
        return computer.asClient();
      },
      agentIdWaitMs: 20,
    },
  );
}

async function notified(): Promise<QueuedMessage> {
  for (let i = 0; i < 200 && queued.length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const [message] = queued;
  if (!message) throw new Error("No task notification was queued");
  return message;
}

beforeAll(() => settingsManager.initialize());

afterEach(() => {
  queued.length = 0;
  backgroundTasks.clear();
  clearAllSubagents();
});

test("retries when the replacement socket opens but snapshot sync fails", async () => {
  const first = new FakeComputer(() => accepted);
  const unsynced = new FakeComputer(
    () => accepted,
    () => {
      throw new Error("sync timed out");
    },
  );
  const recovered = new FakeComputer(
    () => accepted,
    (computer) =>
      computer.snapshot({ status: "completed", result: "Recovered" }),
  );
  const result = await launch([first, unsynced, recovered]);
  if (!result.success) throw new Error(result.error);
  first.drop();
  const message = await notified();
  expect(message.text).toContain("Recovered");
  expect(unsynced.closed).toBe(true);
  expect(recovered.syncs).toBe(1);
});
