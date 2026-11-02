import { describe, expect, test } from "bun:test";
import type {
  AppServerClient,
  AppServerMessageHandler,
} from "@/app-server-client";
import type { EnvironmentConnection } from "@/backend/api/environments";
import type {
  LaunchSubagentCommand,
  LaunchSubagentResponse,
} from "@/types/subagent-protocol";
import {
  launchRemoteExternalCodingAgent,
  type SpawnRemoteFollowTask,
} from "./remote-external-coding-agent";

const scope = { agentId: "agent-parent", conversationId: "conv-parent" };
const runtime = {
  agent_id: scope.agentId,
  conversation_id: scope.conversationId,
};
const SHA = "0123456789abcdef0123456789abcdef01234567";

/** The App Server surface a remote worker launch uses, kept in memory. */
class FakeSandbox {
  readonly launches: LaunchSubagentCommand[] = [];
  readonly events: string[] = [];
  private readonly handlers = new Set<AppServerMessageHandler>();

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
  close() {}
  async launchSubagent(
    command: LaunchSubagentCommand,
  ): Promise<LaunchSubagentResponse> {
    this.events.push("launch");
    this.launches.push(command);
    return {
      type: "launch_subagent_response",
      request_id: command.request_id,
      runtime,
      success: true,
      task_id: "remote-task",
      output_file: "/remote/out",
      agent_id: null,
      conversation_id: null,
    };
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
              agent_url: null,
              tool_call_id: "call-1",
              start_time: 0,
              tool_calls: [],
              total_tokens: 0,
              duration_ms: 1,
              result,
            },
          ],
        } as never,
        "control",
      );
  }
}

const sandbox: EnvironmentConnection = {
  id: "env-1",
  connectionId: "conn-1",
  deviceId: "sandbox-1",
  connectionName: "sandbox",
  organizationId: "org-1",
  podId: null,
  connectedAt: 1,
  lastHeartbeat: Date.now(),
  lastSeenAt: 1,
  firstSeenAt: 1,
  metadata: { launch_subagent_notify_caller: true },
};

function launchOn(
  computer: string,
  fake: FakeSandbox,
  wait: { warning?: string } = {},
) {
  let spawned: Parameters<SpawnRemoteFollowTask>[0] | undefined;
  const result = launchRemoteExternalCodingAgent(
    {
      type: "claude-code",
      computer,
      prompt: "Fix the bug",
      description: "Fix the bug",
      toolCallId: "call-1",
      parentScope: scope,
    },
    {
      spawn: (args) => {
        spawned = args;
        return { taskId: "t", outputFile: "/out", subagentId: "s" };
      },
      resolveComputer: async () => ({
        connectionId: "conn-1",
        environment: sandbox,
      }),
      connect: async () => fake.asClient(),
      waitForClones: async (_client, repositories) => {
        fake.events.push(
          `wait:${repositories.map((repository) => repository.repo).join(",")}`,
        );
        return wait;
      },
      agentIdWaitMs: 1,
    },
  );
  return { result, spawned: () => spawned };
}

describe("remote external workers on a sandbox with repos", () => {
  test("wait for the clones, then start in the first repository", async () => {
    const fake = new FakeSandbox();
    const { result } = launchOn(`cloud:owner/app@${SHA},owner/lib`, fake);
    expect(await result).toMatchObject({ success: true });
    expect(fake.events).toEqual(["wait:app,lib", "launch"]);
    expect(fake.launches[0]).toMatchObject({
      cwd: "/root/workspace/app",
      args: { subagent_type: "claude-code", prompt: "Fix the bug" },
    });
    // cwd rides outside args: older listeners reject unknown args keys.
    expect(fake.launches[0]?.args).not.toHaveProperty("cwd");
  });

  test("a plain cloud sandbox or named computer keeps the parent's cwd", async () => {
    for (const computer of ["cloud", "office-mac"]) {
      const fake = new FakeSandbox();
      expect(await launchOn(computer, fake).result).toMatchObject({
        success: true,
      });
      expect(fake.events).toEqual(["launch"]);
      expect(fake.launches[0]).not.toHaveProperty("cwd");
    }
  });

  test("a clone that outlasts the wait is noted in the prompt and the report", async () => {
    const fake = new FakeSandbox();
    const warning = "Repository clone still in progress after 240s";
    const { result, spawned } = launchOn("cloud:owner/app", fake, {
      warning,
    });
    expect(await result).toMatchObject({ success: true });
    expect(fake.launches[0]?.args.prompt).toBe(
      `<system-reminder>\n${warning}\n</system-reminder>\n\nFix the bug`,
    );
    const spawnArgs = spawned();
    if (!spawnArgs) throw new Error("follow task was not spawned");
    const report = spawnArgs.deps.spawnSubagentImpl(
      "claude-code",
      "Fix the bug",
      undefined,
      "s",
    );
    fake.finish("Fixed it.");
    expect(await report).toMatchObject({
      success: true,
      report: `Warning: ${warning}\n\nFixed it.`,
    });
  });
});
