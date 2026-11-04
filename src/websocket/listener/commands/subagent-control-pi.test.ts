import { afterEach, describe, expect, test } from "bun:test";
import { clearAllSubagents } from "@/agent/subagent-state";
import type { SubagentResult } from "@/agent/subagents";
import {
  clearNativeSessionCaptureForTests,
  rememberNativeSession,
} from "@/tools/impl/native-session-capture";
import { backgroundTasks } from "@/tools/impl/process_manager";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { createConversationRuntime } from "@/websocket/listener/runtime";
import {
  __resetSubagentControlDedupeForTests,
  handleSubagentMessageCommand,
} from "./subagent-control";

const SESSION = "0190f5c2-6c1e-7b3a-9f4e-1a2b3c4d5e6f";
const agentId = `pi_${SESSION}`;
const runtime = { agent_id: "agent-a", conversation_id: "conv-a" };
const workerEnv = {
  resolveSecretEnv: async () => ({}),
  resolveMcpReminder: async () => "<mcp>",
};

function parent() {
  // Recorded by the launch on this computer; not a Cloud URL, so no upload.
  rememberNativeSession(
    "pi",
    SESSION,
    { agentId: runtime.agent_id, conversationId: runtime.conversation_id },
    "http://localhost:8283",
  );
  return createConversationRuntime(
    createRuntime(),
    runtime.agent_id,
    runtime.conversation_id,
  );
}

afterEach(async () => {
  clearAllSubagents();
  backgroundTasks.clear();
  __resetSubagentControlDedupeForTests();
  await clearNativeSessionCaptureForTests();
});

describe("remote pi subagent control", () => {
  test("steers a pi session owned by the launching conversation", async () => {
    let seen: { sessionId: string; mcpReminder?: string } | undefined;
    const response = await handleSubagentMessageCommand(
      {
        type: "subagent_message",
        request_id: "pi-steer",
        runtime,
        agent_id: agentId,
        message: "Go left",
      },
      parent(),
      {
        workerEnv,
        sendPi: async (options) => {
          seen = options;
          return { mode: "steered" };
        },
      },
    );
    expect(response).toMatchObject({ success: true, delivery: "steered" });
    expect(seen).toMatchObject({ sessionId: SESSION, mcpReminder: "<mcp>" });
  });

  test("tracks a resumed pi turn and reserves its transcript capture", async () => {
    const reserved: string[] = [];
    let trackedType: string | undefined;
    const response = await handleSubagentMessageCommand(
      {
        type: "subagent_message",
        request_id: "pi-resume",
        runtime,
        agent_id: agentId,
        message: "Continue",
        tool_call_id: "call-9",
      },
      parent(),
      {
        workerEnv,
        reserveCapture: async (source) => {
          reserved.push(source);
          return { capture: async () => {} };
        },
        sendPi: async (options) => {
          await options.beforeStart?.(SESSION);
          return {
            mode: "new_turn",
            completion: Promise.resolve({
              agentId,
              success: true,
              report: "Done",
            } satisfies SubagentResult),
            interrupt: async () => {},
          };
        },
        track: ((args: { type: string }) => {
          trackedType = args.type;
          return {
            taskId: "task-follow",
            outputFile: "/tmp/follow",
            subagentId: "subagent-follow",
          };
        }) as never,
      },
    );
    expect(response).toMatchObject({ success: true, delivery: "resumed" });
    expect(reserved).toEqual(["pi"]);
    expect(trackedType).toBe("pi");
  });
});
