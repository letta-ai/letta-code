import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAllSubagents } from "@/agent/subagent-state";
import type { SubagentResult } from "@/agent/subagents";
import type {
  AppServerClient,
  AppServerDisconnectHandler,
  AppServerMessageHandler,
} from "@/app-server-client";
import type { EnvironmentConnection } from "@/backend/api/environments";
import { settingsManager } from "@/settings-manager";
import type { SubagentSnapshot } from "@/types/protocol_v2";
import type {
  SubagentMessageCommand,
  SubagentMessageResponse,
  SubagentStopCommand,
} from "@/types/subagent-protocol";
import { sendRemoteExternalCodingAgentMessage } from "./remote-external-coding-agent";
import { closeTaskProgressLog, openTaskProgressLog } from "./task-transcript";

const scope = { agentId: "agent-parent", conversationId: "conv-parent" };
const runtime = {
  agent_id: scope.agentId,
  conversation_id: scope.conversationId,
};

class FakeComputer {
  readonly messages: SubagentMessageCommand[] = [];
  readonly stops: SubagentStopCommand[] = [];
  closed = false;
  private readonly messageHandlers = new Set<AppServerMessageHandler>();

  asClient(): AppServerClient {
    return this as unknown as AppServerClient;
  }

  onMessage(handler: AppServerMessageHandler) {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onDisconnect(_handler: AppServerDisconnectHandler) {
    return () => {};
  }

  sendRaw() {}

  async sendSubagentMessage(
    command: SubagentMessageCommand,
  ): Promise<SubagentMessageResponse> {
    this.messages.push(command);
    return {
      type: "subagent_message_response" as const,
      request_id: command.request_id,
      runtime,
      success: true as const,
      delivery: "resumed",
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
}

const environment = {
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
  metadata: {
    launch_subagent_notify_caller: true,
    subagent_message: true,
  },
} satisfies EnvironmentConnection;

beforeAll(() => settingsManager.initialize());

afterEach(() => clearAllSubagents());

describe("remote external coding agent control", () => {
  const qualified = "claude_11111111-1111-4111-8111-111111111111@device-1";
  const controlDeps = (computer: FakeComputer) => ({
    resolveComputer: async () => ({
      connectionId: "conn-1",
      environment,
    }),
    connect: async () => computer.asClient(),
  });

  test("a resumed reply logs progress before its terminal snapshot", async () => {
    const computer = new FakeComputer();
    let completion: Promise<SubagentResult> | undefined;
    const dir = mkdtempSync(join(tmpdir(), "letta-follow-"));
    const outputFile = join(dir, "task.log");
    const subagentId = "subagent-follow";
    try {
      await sendRemoteExternalCodingAgentMessage(
        {
          agentId: qualified,
          message: "Continue",
          toolCallId: "follow-call",
          parentScope: scope,
        },
        {
          ...controlDeps(computer),
          track: (input) => {
            completion = input.completion;
            openTaskProgressLog(subagentId, outputFile);
            return { taskId: "task-follow", outputFile, subagentId };
          },
        },
      );
      expect(computer.messages[0]?.tool_call_id).toBe("follow-call");
      const progress = {
        id: "p1",
        text: "Resumed worker is active",
        at: "2026-01-01T00:00:00Z",
      };
      computer.snapshot({
        tool_call_id: "follow-call",
        progress_texts: [progress],
      });
      await Bun.sleep(0);
      expect(readFileSync(outputFile, "utf8")).toContain(
        "text: Resumed worker is active",
      );
      computer.snapshot(
        {
          tool_call_id: "follow-call",
          status: "completed",
          result: "Followed up",
        },
        2,
      );
      expect((await completion)?.report).toBe("Followed up");
    } finally {
      closeTaskProgressLog(subagentId);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a tracking failure stops the resumed worker and releases the client", async () => {
    const computer = new FakeComputer();

    await expect(
      sendRemoteExternalCodingAgentMessage(
        {
          agentId: qualified,
          message: "Continue",
          toolCallId: "follow-call",
          parentScope: scope,
        },
        {
          ...controlDeps(computer),
          track: () => {
            throw new Error("tracking failed");
          },
        },
      ),
    ).rejects.toThrow("tracking failed");

    expect(computer.stops).toHaveLength(1);
    expect(computer.stops[0]).toMatchObject({
      runtime,
      agent_id: "claude_11111111-1111-4111-8111-111111111111",
    });
    expect(computer.closed).toBe(true);
  });
});
