import type {
  AppServerClient,
  AppServerDisconnectHandler,
  AppServerMessageHandler,
} from "@/app-server-client";
import type { SubagentSnapshot } from "@/types/protocol_v2";
import type {
  LaunchSubagentCommand,
  LaunchSubagentResponse,
  SubagentMessageCommand,
  SubagentMessageResponse,
  SubagentStopCommand,
} from "@/types/subagent-protocol";
export const runtime = {
  agent_id: "agent-parent",
  conversation_id: "conv-parent",
};

export class FakeComputer {
  readonly launches: LaunchSubagentCommand[] = [];
  readonly messages: SubagentMessageCommand[] = [];
  readonly stops: SubagentStopCommand[] = [];
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

  async stopSubagent(command: SubagentStopCommand) {
    this.stops.push(command);
    return {
      type: "subagent_stop_response" as const,
      request_id: command.request_id,
      runtime,
      agent_id: command.agent_id,
      success: true,
      stopped: true,
      cleanup_confirmed: true,
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
