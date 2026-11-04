import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { clearAllSubagents } from "@/agent/subagent-state";
import type {
  AppServerClient,
  AppServerDisconnectHandler,
  AppServerMessageHandler,
} from "@/app-server-client";
import type { DirectComputer } from "@/backend/direct-computers";
import { settingsManager } from "@/settings-manager";
import type { SubagentSnapshot } from "@/types/protocol_v2";
import type {
  LaunchSubagentCommand,
  SubagentMessageCommand,
  SubagentStopCommand,
} from "@/types/subagent-protocol";
import type { QueuedMessage } from "@/utils/message-queue-bridge";
import { backgroundTasks } from "./process_manager";
import {
  launchRemoteExternalCodingAgent,
  type SpawnRemoteFollowTask,
  sendRemoteExternalCodingAgentMessage,
  stopRemoteExternalCodingAgent,
} from "./remote-external-coding-agent";
import { launchSubagent, spawnBackgroundSubagentTask } from "./task";

const scope = { agentId: "agent-parent", conversationId: "conv-parent" };
const runtime = {
  agent_id: scope.agentId,
  conversation_id: scope.conversationId,
};
const SESSION = "0190f5c2-6c1e-7b3a-9f4e-1a2b3c4d5e6f";
const record: DirectComputer = {
  name: "build-box",
  url: "wss://build-box.example.test:4500/ws",
  tokenFile: "/tmp/does-not-matter",
};

/** A direct App Server: answers `app_server_info` and the subagent commands. */
class FakeDirectServer {
  readonly launches: LaunchSubagentCommand[] = [];
  readonly messages: SubagentMessageCommand[] = [];
  readonly stops: SubagentStopCommand[] = [];
  infos = 0;
  closed = false;
  private readonly messageHandlers = new Set<AppServerMessageHandler>();
  private readonly disconnectHandlers = new Set<AppServerDisconnectHandler>();

  constructor(
    private readonly capabilities: {
      launch_subagent_notify_caller?: boolean;
      subagent_message?: boolean;
      external_harnesses?: string[];
    } = { launch_subagent_notify_caller: true, subagent_message: true },
  ) {}

  asClient(): AppServerClient {
    return this as unknown as AppServerClient;
  }

  async info() {
    this.infos += 1;
    return {
      type: "app_server_info_response",
      request_id: "info",
      success: true,
      backend: "local",
      letta_code_version: "0.0.0-test",
      protocol_version: 1,
      capabilities: this.capabilities,
    };
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
    this.launches.push(command);
    return {
      type: "launch_subagent_response",
      request_id: command.request_id,
      runtime,
      success: true,
      task_id: "remote-task",
      output_file: "/remote/out",
      agent_id: `codex_${SESSION}`,
      conversation_id: null,
    };
  }

  async sendSubagentMessage(command: SubagentMessageCommand) {
    this.messages.push(command);
    return {
      type: "subagent_message_response",
      request_id: command.request_id,
      runtime,
      success: true,
      delivery: "steered",
    };
  }

  async stopSubagent(command: SubagentStopCommand) {
    this.stops.push(command);
    return {
      type: "subagent_stop_response",
      request_id: command.request_id,
      runtime,
      agent_id: command.agent_id,
      success: true,
      stopped: true,
    };
  }

  async sync() {
    return { type: "sync_response" };
  }

  close() {
    this.closed = true;
  }

  snapshot(snapshot: Partial<SubagentSnapshot>) {
    for (const handler of this.messageHandlers)
      handler(
        {
          type: "update_subagent_state",
          runtime,
          seq: 1,
          subagents: [
            {
              subagent_id: "remote-subagent",
              subagent_type: "codex",
              description: "Fix the bug",
              status: "running",
              agent_url: null,
              tool_call_id: "call-1",
              start_time: 0,
              tool_calls: [],
              total_tokens: 0,
              duration_ms: 0,
              ...snapshot,
            },
          ],
        } as never,
        "control",
      );
  }
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

function directDeps(server: FakeDirectServer) {
  const connected: DirectComputer[] = [];
  return {
    connected,
    deps: {
      resolveDirectComputer: (name: string) => {
        if (name !== record.name) throw new Error(`unknown ${name}`);
        return record;
      },
      connectDirect: async (computer: DirectComputer) => {
        connected.push(computer);
        return server.asClient();
      },
      resolveComputer: async () => {
        throw new Error("direct computers must not hit Cloud environments");
      },
      connect: async () => {
        throw new Error("direct computers must not use the Cloud relay");
      },
    },
  };
}

beforeAll(() => settingsManager.initialize());

afterEach(() => {
  queued.length = 0;
  backgroundTasks.clear();
  clearAllSubagents();
});

describe("direct App Server computers", () => {
  test("launch connects straight to the App Server and qualifies IDs with direct:<name>", async () => {
    const server = new FakeDirectServer();
    const { deps, connected } = directDeps(server);
    const result = await launchRemoteExternalCodingAgent(
      {
        type: "codex",
        computer: "direct:build-box",
        prompt: "Fix the bug",
        description: "Fix the bug",
        toolCallId: "call-1",
        parentScope: scope,
      },
      { spawn, reconnectDelayMs: 1, agentIdWaitMs: 20, ...deps },
    );
    if (!result.success) throw new Error(result.error);
    expect(connected).toEqual([record]);
    expect(server.infos).toBe(1);
    expect(result.agent_id).toBe(`codex_${SESSION}@direct:build-box`);
    // The remote backend need not know the caller's MCP servers.
    expect(server.launches[0]).toMatchObject({
      runtime,
      notify: "caller",
      args: { subagent_type: "codex", mcp: { inherit: false } },
    });

    server.snapshot({ status: "completed", result: "Done" });
    for (let i = 0; i < 200 && queued.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(queued[0]).toMatchObject({
      agentId: scope.agentId,
      conversationId: scope.conversationId,
    });
  });

  test("an explicit mcp selection is forwarded unchanged", async () => {
    const server = new FakeDirectServer();
    const result = await launchRemoteExternalCodingAgent(
      {
        type: "codex",
        computer: "direct:build-box",
        prompt: "p",
        description: "d",
        toolCallId: "call-1",
        mcp: { inherit: true, servers: ["docs"] },
        parentScope: scope,
      },
      { spawn, agentIdWaitMs: 1, ...directDeps(server).deps },
    );
    expect(result.success).toBe(true);
    expect(server.launches[0]?.args.mcp).toEqual({
      inherit: true,
      servers: ["docs"],
    });
    server.snapshot({ status: "completed", result: "Done" });
  });

  test("an App Server without caller notification is reported as outdated", async () => {
    const server = new FakeDirectServer({});
    const result = await launchRemoteExternalCodingAgent(
      {
        type: "codex",
        computer: "direct:build-box",
        prompt: "p",
        description: "d",
        parentScope: scope,
      },
      { spawn, ...directDeps(server).deps },
    );
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("older Letta Code"),
    });
    expect(server.launches).toHaveLength(0);
    expect(server.closed).toBe(true);
  });

  test("unknown and malformed direct selectors fail before connecting", async () => {
    const server = new FakeDirectServer();
    const { deps, connected } = directDeps(server);
    for (const computer of ["direct:other", "direct:", "direct:bad name"]) {
      const result = await launchRemoteExternalCodingAgent(
        {
          type: "codex",
          computer,
          prompt: "p",
          description: "d",
          parentScope: scope,
        },
        { spawn, ...deps },
      );
      expect(result.success).toBe(false);
    }
    expect(connected).toHaveLength(0);
  });

  test("stop and steer resolve @direct:<name> through the direct store", async () => {
    const server = new FakeDirectServer();
    const { deps, connected } = directDeps(server);
    const agentId = `codex_${SESSION}@direct:build-box`;
    expect(
      await stopRemoteExternalCodingAgent(
        { agentId, parentScope: scope },
        deps,
      ),
    ).toEqual({ stopped: true });
    expect(server.stops[0]?.agent_id).toBe(`codex_${SESSION}`);

    expect(
      await sendRemoteExternalCodingAgentMessage(
        { agentId, message: "also add a test", parentScope: scope },
        deps,
      ),
    ).toEqual({ delivery: "steered" });
    expect(server.messages[0]).toMatchObject({
      agent_id: `codex_${SESSION}`,
      message: "also add a test",
    });
    expect(connected).toHaveLength(2);
  });

  test("steering an App Server without subagent_message is reported as outdated", async () => {
    const server = new FakeDirectServer({
      launch_subagent_notify_caller: true,
    });
    await expect(
      stopRemoteExternalCodingAgent(
        {
          agentId: `codex_${SESSION}@direct:build-box`,
          parentScope: scope,
        },
        directDeps(server).deps,
      ),
    ).rejects.toThrow("older Letta Code");
    expect(server.closed).toBe(true);
  });

  test("Letta subagents cannot target a direct computer", async () => {
    const result = await launchSubagent({
      prompt: "p",
      description: "d",
      computer: "direct:build-box",
      parentScope: scope,
    });
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining(
        "Direct computers run external coding workers only",
      ),
    });
  });

  test("pi launches need a computer that advertises the pi harness", async () => {
    const launchPi = (server: FakeDirectServer) =>
      launchRemoteExternalCodingAgent(
        {
          type: "pi",
          computer: "direct:build-box",
          prompt: "p",
          description: "d",
          toolCallId: "call-1",
          parentScope: scope,
        },
        { spawn, agentIdWaitMs: 1, ...directDeps(server).deps },
      );
    const older = new FakeDirectServer({
      launch_subagent_notify_caller: true,
      subagent_message: true,
      external_harnesses: ["claude-code", "codex", "opencode", "cursor"],
    });
    expect(await launchPi(older)).toEqual({
      success: false,
      error: expect.stringContaining("can't run pi subagents remotely"),
    });
    expect(older.launches).toHaveLength(0);

    const current = new FakeDirectServer({
      launch_subagent_notify_caller: true,
      subagent_message: true,
      external_harnesses: ["codex", "pi"],
    });
    expect((await launchPi(current)).success).toBe(true);
    expect(current.launches[0]?.args).toMatchObject({ subagent_type: "pi" });
    current.snapshot({ status: "completed", result: "Done" });
  });

  test("Cloud computers without the pi capability are reported as outdated", async () => {
    const connects: string[] = [];
    const result = await launchRemoteExternalCodingAgent(
      {
        type: "pi",
        computer: "brad-box",
        prompt: "p",
        description: "d",
        parentScope: scope,
      },
      {
        spawn,
        resolveComputer: async () => ({
          connectionId: "conn-1",
          environment: {
            id: "env-1",
            connectionId: "conn-1",
            deviceId: "device-1",
            connectionName: "brad-box",
            organizationId: "org-1",
            podId: "pod-1",
            connectedAt: 1,
            lastHeartbeat: Date.now(),
            lastSeenAt: 1,
            firstSeenAt: 1,
            metadata: { launch_subagent_notify_caller: true },
          },
        }),
        connect: async (id) => {
          connects.push(id);
          throw new Error("must not connect");
        },
      },
    );
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("can't run pi subagents remotely"),
    });
    expect(connects).toHaveLength(0);
  });
});
