import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { clearAllSubagents } from "@/agent/subagent-state";
import type {
  AppServerClient,
  AppServerDisconnectHandler,
  AppServerMessageHandler,
} from "@/app-server-client";
import type { EnvironmentConnection } from "@/backend/api/environments";
import { settingsManager } from "@/settings-manager";
import type { LaunchSubagentCommand } from "@/types/subagent-protocol";
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

/** A computer connection that accepts one launch and can drop on demand. */
class DroppableComputer {
  private readonly messageHandlers = new Set<AppServerMessageHandler>();
  private readonly disconnectHandlers = new Set<AppServerDisconnectHandler>();

  asClient(): AppServerClient {
    return this as unknown as AppServerClient;
  }

  onMessage(handler: AppServerMessageHandler) {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onDisconnect(handler: AppServerDisconnectHandler) {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  sendRaw() {}

  async launchSubagent(command: LaunchSubagentCommand) {
    return {
      type: "launch_subagent_response",
      request_id: command.request_id,
      runtime,
      success: true,
      task_id: "remote-task",
      output_file: "/remote/out",
      agent_id: "claude_11111111-1111-4111-8111-111111111111",
      conversation_id: null,
    };
  }

  close() {}

  drop() {
    for (const handler of this.disconnectHandlers)
      handler({ channel: "control", event: { code: 1006 } });
  }
}

const environment = {
  id: "env-1",
  connectionId: "conn-1",
  deviceId: "device-1",
  connectionName: "build-box",
  organizationId: "org-1",
  podId: "pod-1",
  connectedAt: 1,
  lastHeartbeat: Date.now(),
  lastSeenAt: 1,
  firstSeenAt: 1,
  metadata: { launch_subagent_notify_caller: true, subagent_message: true },
} satisfies EnvironmentConnection;

const spawn: SpawnRemoteFollowTask = (args) =>
  spawnBackgroundSubagentTask({
    ...args,
    deps: {
      ...args.deps,
      addToMessageQueueImpl: () => {},
      copyGitHubPullRequestTagsImpl: async () => {},
      runSubagentStopHooksImpl: async () => ({
        blocked: false,
        errored: false,
        feedback: [],
        results: [],
      }),
    },
  });

beforeAll(() => settingsManager.initialize());

afterEach(() => {
  backgroundTasks.clear();
  clearAllSubagents();
});

describe("TaskStop while a remote follower is reconnecting", () => {
  test("abort wakes a reconnect that never settles", async () => {
    const first = new DroppableComputer();
    let connects = 0;
    const reconnecting = Promise.withResolvers<void>();
    const launched = await launchRemoteExternalCodingAgent(
      {
        type: "claude-code",
        computer: "build-box",
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
          environment,
        }),
        connect: () => {
          if (connects++ === 0) return Promise.resolve(first.asClient());
          reconnecting.resolve();
          // The computer accepts the TCP connection but never opens it.
          return new Promise<AppServerClient>(() => {});
        },
      },
    );
    if (!launched.success) throw new Error(launched.error);

    first.drop();
    await reconnecting.promise;

    const result = await task_stop(
      { task_id: launched.task_id },
      {
        stopRemoteExternal: async () => ({ stopped: true }),
        // Far longer than the abort should take, so the bound isn't what returns.
        completionTimeoutMs: 2_000,
      },
    );
    expect(result).toEqual({
      killed: true,
      output: "Stopped the remote external subagent",
    });
    expect(backgroundTasks.get(launched.task_id)?.status).toBe("failed");
  });
});
