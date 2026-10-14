import {
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { clearAllSubagents } from "@/agent/subagent-state";
import type {
  AppServerClient,
  AppServerDisconnectHandler,
  AppServerMessageHandler,
} from "@/app-server-client";
import type { EnvironmentConnection } from "@/backend/api/environments";
import { settingsManager } from "@/settings-manager";
import type { SubagentSnapshot } from "@/types/protocol_v2";
import type {
  LaunchSubagentCommand,
  LaunchSubagentResponse,
} from "@/types/subagent-protocol";
import type { QueuedMessage } from "@/utils/message-queue-bridge";
import { backgroundTasks } from "./process_manager";
import {
  launchRemoteExternalCodingAgent,
  type RemoteExternalCodingAgentLaunch,
  type SpawnRemoteFollowTask,
} from "./remote-external-coding-agent";
import { spawnBackgroundSubagentTask } from "./task";

const scope = { agentId: "agent-parent", conversationId: "conv-parent" };
const originalApiKey = process.env.LETTA_API_KEY;
const originalBaseUrl = process.env.LETTA_BASE_URL;
const runtime = {
  agent_id: scope.agentId,
  conversation_id: scope.conversationId,
};

/** The App Server client surface this module uses, backed by in-memory frames. */
class FakeComputer {
  readonly launches: LaunchSubagentCommand[] = [];
  readonly acks: number[] = [];
  syncs = 0;
  closed = false;
  private readonly messageHandlers = new Set<AppServerMessageHandler>();
  private readonly disconnectHandlers = new Set<AppServerDisconnectHandler>();

  constructor(
    private readonly respond: (
      command: LaunchSubagentCommand,
    ) => Partial<LaunchSubagentResponse>,
    private readonly onSync: (computer: FakeComputer) => void = () => {},
  ) {}

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

  sendRaw(command: { type: string; seq?: unknown }) {
    if (command.type === "ack" && typeof command.seq === "number")
      this.acks.push(command.seq);
  }

  async launchSubagent(
    command: LaunchSubagentCommand,
  ): Promise<LaunchSubagentResponse> {
    this.launches.push(command);
    return {
      type: "launch_subagent_response",
      request_id: command.request_id,
      runtime,
      ...this.respond(command),
    } as LaunchSubagentResponse;
  }

  async sync() {
    this.syncs += 1;
    this.onSync(this);
    return { type: "sync_response" };
  }

  close() {
    this.closed = true;
  }

  snapshot(snapshot: Partial<SubagentSnapshot>, seq = 1) {
    for (const handler of this.messageHandlers)
      handler(
        {
          type: "update_subagent_state",
          runtime,
          seq,
          subagents: [
            {
              subagent_id: "remote-subagent",
              subagent_type: "claude-code",
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

  /** A snapshot from a listener that has no subagents for this conversation. */
  emptySnapshot(seq = 1) {
    for (const handler of this.messageHandlers)
      handler(
        { type: "update_subagent_state", runtime, seq, subagents: [] } as never,
        "control",
      );
  }

  drop() {
    for (const handler of this.disconnectHandlers)
      handler({ channel: "control", event: { code: 1013 } });
  }
}

const accepted = {
  success: true as const,
  task_id: "remote-task",
  output_file: "/remote/out",
  agent_id: "claude_session",
  conversation_id: null,
};

function environment(capable: boolean): EnvironmentConnection {
  return {
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
    metadata: capable ? { launch_subagent_notify_caller: true } : {},
  };
}

const queued: QueuedMessage[] = [];
function mockApiFetch(handler: (request: Request) => Promise<Response>) {
  const fetch = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
    return handler(request);
  }) as typeof globalThis.fetch;
  return spyOn(globalThis, "fetch").mockImplementation(fetch);
}

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

function launch(
  computers: FakeComputer[],
  overrides: Partial<RemoteExternalCodingAgentLaunch> = {},
  capable = true,
) {
  let connects = 0;
  return launchRemoteExternalCodingAgent(
    {
      type: "claude-code",
      computer: "brad-box",
      prompt: "Fix the bug",
      description: "Fix the bug",
      toolCallId: "call-1",
      parentScope: scope,
      ...overrides,
    },
    {
      spawn,
      reconnectDelayMs: 1,
      resolveComputer: async () => ({
        connectionId: "conn-1",
        environment: environment(capable),
      }),
      connect: async () => {
        const computer = computers[connects++];
        if (!computer) throw new Error("no more computers");
        return computer.asClient();
      },
    },
  );
}

/** The notification follows the task's lifecycle, after its completion settles. */
async function notified(): Promise<QueuedMessage> {
  for (let i = 0; i < 200 && queued.length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const [message] = queued;
  if (!message) throw new Error("No task notification was queued");
  return message;
}

beforeAll(() => settingsManager.initialize());

afterEach(() => {
  mock.restore();
  if (originalApiKey === undefined) delete process.env.LETTA_API_KEY;
  else process.env.LETTA_API_KEY = originalApiKey;
  if (originalBaseUrl === undefined) delete process.env.LETTA_BASE_URL;
  else process.env.LETTA_BASE_URL = originalBaseUrl;
  queued.length = 0;
  backgroundTasks.clear();
  clearAllSubagents();
});

describe("launchRemoteExternalCodingAgent", () => {
  test.each(["codex", "claude-code"] as const)(
    "%s cloud launches create fresh hidden conversations without changing caller routing",
    async (type) => {
      process.env.LETTA_API_KEY = "test-key";
      process.env.LETTA_BASE_URL = "https://api.example.test";
      const requests: Array<{ method: string; path: string; body: unknown }> =
        [];
      let conversations = 0;
      mockApiFetch(async (request) => {
        const path = new URL(request.url).pathname;
        const text = await request.text();
        requests.push({
          method: request.method,
          path,
          body: text ? JSON.parse(text) : null,
        });
        if (path === "/v1/conversations/") {
          expect(new URL(request.url).searchParams.get("agent_id")).toBe(
            scope.agentId,
          );
          return Response.json({ id: `conv-worker-${++conversations}` });
        }
        if (path === `/v1/agents/${scope.agentId}/sandboxes`)
          return Response.json({
            sandboxId: `sandbox-${conversations}`,
            deviceId: `device-${conversations}`,
            connectionName: "cloud",
          });
        if (path === `/v1/environments/device-${conversations}`)
          return Response.json({
            ...environment(true),
            connectionId: `conn-${conversations}`,
          });
        throw new Error(`Unexpected request: ${request.method} ${path}`);
      });

      for (const worker of [1, 2]) {
        const computer = new FakeComputer(() => accepted);
        const connect = spyOn(
          { connect: async () => computer.asClient() },
          "connect",
        );
        const result = await launchRemoteExternalCodingAgent(
          {
            type,
            computer: "cloud",
            prompt: "Fix the bug",
            description: "Fix the bug",
            parentScope: scope,
          },
          { spawn, connect },
        );
        if (!result.success) throw new Error(result.error);
        expect(result.success).toBe(true);
        expect(connect).toHaveBeenCalledWith(`conn-${worker}`, scope);
        expect(computer.launches[0]).toMatchObject({
          runtime,
          notify: "caller",
        });
        expect(requests.slice((worker - 1) * 3, worker * 3)).toEqual([
          {
            method: "POST",
            path: "/v1/conversations/",
            body: { hidden: true },
          },
          {
            method: "POST",
            path: `/v1/agents/${scope.agentId}/sandboxes`,
            body: { conversationId: `conv-worker-${worker}` },
          },
          {
            method: "GET",
            path: `/v1/environments/device-${worker}`,
            body: null,
          },
        ]);
        computer.snapshot({ status: "completed", result: "Done" });
        expect(await notified()).toMatchObject({
          agentId: scope.agentId,
          conversationId: scope.conversationId,
        });
        queued.length = 0;
      }
    },
  );

  test("named computers use the existing environment resolver without creating conversations", async () => {
    process.env.LETTA_API_KEY = "test-key";
    process.env.LETTA_BASE_URL = "https://api.example.test";
    const fetch = mockApiFetch(async (request) => {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe("/v1/environments");
      expect(new URL(request.url).searchParams.get("limit")).toBe("100");
      return Response.json({
        connections: [environment(true)],
        hasNextPage: false,
      });
    });
    const computer = new FakeComputer(() => accepted);
    const connect = spyOn(
      { connect: async () => computer.asClient() },
      "connect",
    );
    const result = await launchRemoteExternalCodingAgent(
      {
        type: "codex",
        computer: "brad-box",
        prompt: "Fix the bug",
        description: "Fix the bug",
        parentScope: scope,
      },
      { spawn, connect },
    );
    if (!result.success) throw new Error(result.error);
    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("conn-1", scope);
    expect(computer.launches[0]).toMatchObject({ runtime, notify: "caller" });
    computer.snapshot({ status: "completed", result: "Done" });
    await notified();
  });

  test("launches with notify caller and notifies locally from the remote snapshot result", async () => {
    const computer = new FakeComputer(() => accepted);
    const result = await launch([computer]);
    if (!result.success) throw new Error(result.error);
    expect(computer.launches).toEqual([
      expect.objectContaining({
        runtime,
        tool_call_id: "call-1",
        notify: "caller",
        args: {
          subagent_type: "claude-code",
          prompt: "Fix the bug",
          description: "Fix the bug",
        },
      }),
    ]);
    // The remote native session can't be resumed from this machine.
    expect(result.agent_id).toBeNull();

    computer.snapshot({ status: "running" }, 1);
    computer.snapshot(
      { status: "completed", result: "Fixed it remotely", total_tokens: 42 },
      2,
    );
    const message = await notified();

    expect(backgroundTasks.get(result.task_id)?.status).toBe("completed");
    expect(computer.acks).toEqual([1, 2]);
    expect(computer.closed).toBe(true);
    expect(queued).toHaveLength(1);
    expect(message).toMatchObject({
      kind: "task_notification",
      agentId: scope.agentId,
      conversationId: scope.conversationId,
    });
    expect(message.text).toContain("<status>completed</status>");
    expect(message.text).toContain("Fixed it remotely");
  });

  test("reports a remote failure through the local notification", async () => {
    const computer = new FakeComputer(() => accepted);
    const result = await launch([computer]);
    if (!result.success) throw new Error(result.error);
    computer.snapshot({ status: "error", error: "Claude Code crashed" });
    const message = await notified();
    expect(message.text).toContain("<status>failed</status>");
    expect(message.text).toContain("Claude Code crashed");
  });

  test("recovers a completion missed while the socket was down", async () => {
    const first = new FakeComputer(() => accepted);
    const second = new FakeComputer(
      () => accepted,
      (computer) =>
        computer.snapshot({ status: "completed", result: "Done after drop" }),
    );
    const result = await launch([first, second]);
    if (!result.success) throw new Error(result.error);
    first.snapshot({ status: "running" });
    first.drop();
    const message = await notified();
    expect(second.syncs).toBe(1);
    expect(message.text).toContain("Done after drop");
  });

  test("says the worker is no longer listed when the listener lacks it", async () => {
    const first = new FakeComputer(() => accepted);
    // The replacement listener is a new process with no record of the worker.
    const second = new FakeComputer(
      () => accepted,
      (computer) => computer.emptySnapshot(),
    );
    const result = await launch([first, second]);
    if (!result.success) throw new Error(result.error);
    // Drop before any progress snapshot: the accepted launch alone must count.
    first.drop();
    const message = await notified();
    expect(second.syncs).toBe(1);
    expect(message.text).toContain("<status>failed</status>");
    expect(message.text).toContain(
      "The claude-code worker on brad-box is no longer listed",
    );
    expect(message.text).not.toContain("did not survive");
    expect(message.text).not.toContain("may still be running");
  });

  test("tells the caller to update an older Letta Code without connecting", async () => {
    const computer = new FakeComputer(() => accepted);
    for (const type of ["claude-code", "codex"] as const) {
      expect(await launch([computer], { type }, false)).toEqual({
        success: false,
        error: `brad-box is running an older Letta Code that can't run ${type === "codex" ? "Codex" : "Claude Code"} subagents remotely. Update Letta Code on brad-box.`,
      });
    }
    expect(computer.launches).toHaveLength(0);
  });

  test.each([
    [
      "claude-code",
      "not_installed",
      "Claude Code isn't installed on brad-box. Install it there, or run a Letta subagent on that computer instead.",
    ],
    [
      "claude-code",
      "not_signed_in",
      "Claude Code is installed on brad-box but not signed in. Sign in there, or run a Letta subagent on that computer instead.",
    ],
    [
      "codex",
      "not_installed",
      "Codex isn't installed on brad-box. Install it there, or run a Letta subagent on that computer instead.",
    ],
    [
      "codex",
      "not_signed_in",
      "Codex is installed on brad-box but not signed in. Sign in there, or run a Letta subagent on that computer instead.",
    ],
  ] as const)(
    "maps a %s %s startup failure to a generic error",
    async (type, code, error) => {
      const computer = new FakeComputer(() => ({
        success: false,
        error: "Required executable 'claude' was not found on PATH",
        error_code: code,
      }));
      expect(await launch([computer], { type })).toEqual({
        success: false,
        error,
      });
      expect(computer.closed).toBe(true);
      expect(backgroundTasks.size).toBe(0);
    },
  );

  test("surfaces a refused connection as a normal launch error", async () => {
    const computer = new FakeComputer(() => accepted);
    computer.launchSubagent = async () => {
      throw new Error("App-server connection closed (1008)");
    };
    expect(await launch([computer], { type: "codex" })).toEqual({
      success: false,
      error:
        "Couldn't launch codex on brad-box: App-server connection closed (1008)",
    });
    expect(computer.closed).toBe(true);
  });
});
