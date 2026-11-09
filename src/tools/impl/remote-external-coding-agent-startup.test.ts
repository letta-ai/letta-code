import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  clearAllSubagents,
  getSnapshot as getSubagentSnapshot,
} from "@/agent/subagent-state";
import type {
  AppServerClient,
  AppServerMessageHandler,
} from "@/app-server-client";
import type { EnvironmentConnection } from "@/backend/api/environments";
import { settingsManager } from "@/settings-manager";
import type {
  LaunchSubagentCommand,
  LaunchSubagentResponse,
  SubagentStopCommand,
} from "@/types/subagent-protocol";
import type { QueuedMessage } from "@/utils/message-queue-bridge";
import { backgroundTasks } from "./process_manager";
import {
  launchRemoteExternalCodingAgent,
  type SpawnRemoteFollowTask,
} from "./remote-external-coding-agent";
import { spawnBackgroundSubagentTask } from "./task";
import { task_stop } from "./task-stop";

const scope = { agentId: "agent-parent", conversationId: "conv-parent" };
const runtime = {
  agent_id: scope.agentId,
  conversation_id: scope.conversationId,
};

/** A computer whose launch response is held until the test releases it. */
class SlowComputer {
  readonly launches: LaunchSubagentCommand[] = [];
  readonly stops: SubagentStopCommand[] = [];
  private readonly handlers = new Set<AppServerMessageHandler>();
  private readonly response =
    Promise.withResolvers<Partial<LaunchSubagentResponse>>();

  asClient(): AppServerClient {
    return this as unknown as AppServerClient;
  }
  onMessage(handler: AppServerMessageHandler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  onDisconnect() {
    return () => {};
  }
  sendRaw() {}
  async sync() {
    return { type: "sync_response" };
  }
  close() {}
  async launchSubagent(command: LaunchSubagentCommand) {
    this.launches.push(command);
    return {
      type: "launch_subagent_response",
      request_id: command.request_id,
      runtime,
      ...(await this.response.promise),
    } as LaunchSubagentResponse;
  }
  stopResponse: { success: boolean; stopped: boolean; error?: string } = {
    success: true,
    stopped: true,
  };
  async stopSubagent(command: SubagentStopCommand) {
    this.stops.push(command);
    return this.stopResponse;
  }
  respond(response: Partial<LaunchSubagentResponse>) {
    this.response.resolve(response);
  }
  finish(result: string) {
    for (const handler of this.handlers)
      handler(
        {
          type: "update_subagent_state",
          runtime,
          seq: 1,
          subagents: [
            {
              subagent_id: "remote-subagent",
              subagent_type: "claude-code",
              description: "Fix the bug",
              status: "completed",
              result,
              agent_url: null,
              tool_call_id: "call-1",
              start_time: 0,
              tool_calls: [],
              total_tokens: 0,
              duration_ms: 0,
            },
          ],
        } as never,
        "control",
      );
  }
}

const environment = {
  id: "env-1",
  connectionId: "conn-1",
  deviceId: "device-1",
  connectionName: "test-computer",
  organizationId: "org-1",
  podId: "pod-1",
  connectedAt: 1,
  lastHeartbeat: Date.now(),
  lastSeenAt: 1,
  firstSeenAt: 1,
  metadata: { launch_subagent_notify_caller: true, subagent_message: true },
} satisfies EnvironmentConnection;

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

function launch(computer: SlowComputer, startupYieldMs: number | null) {
  return launchRemoteExternalCodingAgent(
    {
      type: "claude-code",
      computer: "test-computer",
      prompt: "Fix the bug",
      description: "Fix the bug",
      toolCallId: "call-1",
      parentScope: scope,
    },
    {
      spawn,
      startupYieldMs,
      resolveComputer: async () => ({ connectionId: "conn-1", environment }),
      connect: async () => computer.asClient(),
      agentIdWaitMs: 1,
      enqueue: (message) => queued.push(message),
    },
  );
}

const session = "claude_11111111-1111-4111-8111-111111111111";
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

async function notified(): Promise<string> {
  for (let i = 0; i < 200 && queued.length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const [message] = queued;
  if (!message) throw new Error("No task notification was queued");
  return message.text;
}

beforeAll(() => settingsManager.initialize());

afterEach(() => {
  queued.length = 0;
  backgroundTasks.clear();
  clearAllSubagents();
});

describe("remote Agent startup yield", () => {
  test("returns a task receipt while the launch is still starting, then reports its result", async () => {
    const computer = new SlowComputer();
    const result = await launch(computer, 20);
    if (!result.success) throw new Error(result.error);
    expect(result.task_id).toBeString();
    expect(result.agent_id).toBeNull();
    expect(computer.launches).toHaveLength(1);
    expect(queued).toHaveLength(0);

    computer.respond({ success: true, agent_id: session });
    await tick();
    // The worker ID the receipt could not carry reaches the task once known.
    expect(getSubagentSnapshot().agents[0]?.agentId).toBe(
      `${session}@device-1`,
    );
    computer.finish("Fixed it remotely");
    const text = await notified();
    expect(text).toContain("<status>completed</status>");
    expect(text).toContain("Fixed it remotely");
    expect(computer.launches).toHaveLength(1);
  });

  test("a launch that fails after the yield is reported through the task", async () => {
    const computer = new SlowComputer();
    const result = await launch(computer, 20);
    expect(result.success).toBe(true);

    computer.respond({ success: false, error: "worker exited" });
    const text = await notified();
    expect(text).toContain("<status>failed</status>");
    expect(text).toContain("Couldn't launch claude-code on test-computer");
    expect(text).toContain("worker exited");
    expect(computer.launches).toHaveLength(1);
  });

  test("a launch that fails within the yield returns the error without a task", async () => {
    const computer = new SlowComputer();
    computer.respond({ success: false, error: "worker exited" });
    const result = await launch(computer, 10_000);
    expect(result).toEqual({
      success: false,
      error: "Couldn't launch claude-code on test-computer: worker exited",
    });
    expect(backgroundTasks.size).toBe(0);
  });

  test("TaskStop during a held launch returns promptly and stops the worker once it starts", async () => {
    const computer = new SlowComputer();
    const result = await launch(computer, 20);
    if (!result.success) throw new Error(result.error);

    expect(await task_stop({ task_id: result.task_id })).toEqual({
      killed: true,
    });
    expect(computer.stops).toHaveLength(0);
    expect(await notified()).toContain("Stopped before the claude-code worker");

    computer.respond({ success: true, agent_id: session });
    await tick();
    expect(computer.stops).toEqual([
      expect.objectContaining({ runtime, agent_id: session }),
    ]);
    expect(computer.launches).toHaveLength(1);
    expect(queued).toHaveLength(1);
  });

  test.each([
    {
      name: "a failed late stop is reported with the worker ID",
      stopResponse: { success: false, stopped: false, error: "listener busy" },
      reported: true,
    },
    {
      name: "a worker that already finished is not reported",
      stopResponse: { success: true, stopped: false },
      reported: false,
    },
  ])("$name", async ({ stopResponse, reported }) => {
    const computer = new SlowComputer();
    computer.stopResponse = stopResponse;
    const result = await launch(computer, 20);
    if (!result.success) throw new Error(result.error);
    await task_stop({ task_id: result.task_id });
    await notified();

    computer.respond({ success: true, agent_id: session });
    await tick();
    expect(computer.stops).toHaveLength(1);
    if (!reported) {
      expect(queued).toHaveLength(1);
      return;
    }
    expect(queued).toHaveLength(2);
    const text = queued[1]?.text ?? "";
    expect(text).toContain(`<task-id>${result.task_id}</task-id>`);
    expect(text).toContain("<status>failed</status>");
    expect(text).toContain(`${session}@device-1`);
    expect(text).toContain("listener busy");
  });

  test("without a budget (App Server callers) the launch is awaited", async () => {
    const computer = new SlowComputer();
    let settled = false;
    const outcome = launch(computer, null).finally(() => {
      settled = true;
    });
    await tick(40);
    expect(settled).toBe(false);
    computer.respond({ success: true, agent_id: session });
    expect(await outcome).toMatchObject({
      success: true,
      agent_id: `${session}@device-1`,
    });
  });
});
