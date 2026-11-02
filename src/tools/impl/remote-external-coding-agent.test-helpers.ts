// Shared harness for the remote external coding agent tests: an in-memory
// App Server client standing in for the computer, and launch helpers.
import { afterEach, beforeAll, mock, spyOn } from "bun:test";
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
  ReadSubagentEventsCommand,
  ReadSubagentEventsResponse,
  SubagentEventRecord,
  SubagentMessageCommand,
  SubagentMessageResponse,
  SubagentStopCommand,
} from "@/types/subagent-protocol";
import type { QueuedMessage } from "@/utils/message-queue-bridge";
import { backgroundTasks } from "./process_manager";
import {
  launchRemoteExternalCodingAgent,
  type RemoteExternalCodingAgentLaunch,
  type SpawnRemoteFollowTask,
} from "./remote-external-coding-agent";
import { spawnBackgroundSubagentTask } from "./task";

export const scope = { agentId: "agent-parent", conversationId: "conv-parent" };
export const originalApiKey = process.env.LETTA_API_KEY;
export const originalBaseUrl = process.env.LETTA_BASE_URL;
export const runtime = {
  agent_id: scope.agentId,
  conversation_id: scope.conversationId,
};

/** The App Server client surface this module uses, backed by in-memory frames. */
export class FakeComputer {
  readonly launches: LaunchSubagentCommand[] = [];
  readonly messages: SubagentMessageCommand[] = [];
  readonly stops: SubagentStopCommand[] = [];
  readonly eventReads: Array<Omit<ReadSubagentEventsCommand, "type">> = [];
  /** Events the worker keeps; `undefined` makes reads fail. */
  events: SubagentEventRecord[] | undefined = [];
  /** Events per page, to exercise paging. */
  eventPageSize = 2;
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

  async sendSubagentMessage(
    command: SubagentMessageCommand,
  ): Promise<SubagentMessageResponse> {
    this.messages.push(command);
    return {
      type: "subagent_message_response" as const,
      request_id: command.request_id,
      runtime,
      success: true as const,
      delivery: "steered" as const,
    };
  }

  async readSubagentEvents(
    command: Omit<ReadSubagentEventsCommand, "type" | "request_id">,
  ): Promise<ReadSubagentEventsResponse> {
    this.eventReads.push({ ...command, request_id: "r" });
    const base = {
      type: "read_subagent_events_response" as const,
      request_id: "r",
      runtime,
      subagent_id: command.subagent_id,
    };
    if (!this.events)
      return { ...base, success: false, error: "not kept here" };
    const after = this.events.filter((event) => event.seq > command.after_seq);
    const page = after.slice(0, this.eventPageSize);
    return {
      ...base,
      success: true,
      events: page,
      next_seq: page.at(-1)?.seq ?? command.after_seq,
      has_more: after.length > page.length,
      missed: 0,
    };
  }

  async stopSubagent(command: SubagentStopCommand) {
    this.stops.push(command);
    return {
      type: "subagent_stop_response" as const,
      request_id: command.request_id,
      runtime,
      agent_id: command.agent_id,
      success: true,
      stopped: true,
    };
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

export const accepted = {
  success: true as const,
  task_id: "remote-task",
  output_file: "/remote/out",
  agent_id: "claude_session",
  conversation_id: null,
};

export function environment(
  capable: boolean,
  steering = false,
): EnvironmentConnection {
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
    metadata: capable
      ? {
          launch_subagent_notify_caller: true,
          ...(steering ? { subagent_message: true } : {}),
        }
      : {},
  };
}

export const queued: QueuedMessage[] = [];
export function mockApiFetch(handler: (request: Request) => Promise<Response>) {
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

export const spawn: SpawnRemoteFollowTask = (args) =>
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

export function launch(
  computers: FakeComputer[],
  overrides: Partial<RemoteExternalCodingAgentLaunch> = {},
  capable = true,
  steering = false,
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
        environment: environment(capable, steering),
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

/** The notification follows the task's lifecycle, after its completion settles. */
export async function notified(): Promise<QueuedMessage> {
  for (let i = 0; i < 200 && queued.length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const [message] = queued;
  if (!message) throw new Error("No task notification was queued");
  return message;
}

/** Shared setup and per-test cleanup for the remote launch tests. */
export function installRemoteLaunchTestHooks(): void {
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
}
