import { afterEach, describe, expect, test } from "bun:test";
import {
  clearAllSubagents,
  registerSubagent,
  updateSubagent,
} from "@/agent/subagent-state";
import type { SubagentResult } from "@/agent/subagents";
import { backgroundTasks } from "@/tools/impl/process_manager";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { createConversationRuntime } from "@/websocket/listener/runtime";
import {
  __resetSubagentControlDedupeForTests,
  handleSubagentMessageCommand,
  handleSubagentStopCommand,
} from "./subagent-control";

const nativeId = "claude_11111111-1111-4111-8111-111111111111";
const runtime = { agent_id: "agent-a", conversation_id: "conv-a" };

function fixture() {
  const parent = createConversationRuntime(
    createRuntime(),
    runtime.agent_id,
    runtime.conversation_id,
  );
  registerSubagent("subagent-1", "claude-code", "Work", "call-1", true, false, {
    agentId: runtime.agent_id,
    conversationId: runtime.conversation_id,
  });
  updateSubagent("subagent-1", { agentId: nativeId, status: "running" });
  const abortController = new AbortController();
  backgroundTasks.set("task-1", {
    description: "Work",
    subagentType: "claude-code",
    subagentId: "subagent-1",
    status: "running",
    startTime: new Date(),
    outputFile: "/tmp/out",
    abortController,
  });
  return { parent, abortController };
}

afterEach(() => {
  clearAllSubagents();
  backgroundTasks.clear();
  __resetSubagentControlDedupeForTests();
});

describe("remote external subagent control", () => {
  test("rejects a subagent owned by another runtime", async () => {
    const { parent } = fixture();
    const response = await handleSubagentMessageCommand(
      {
        type: "subagent_message",
        request_id: "wrong-scope",
        runtime: { agent_id: "agent-b", conversation_id: "conv-b" },
        agent_id: nativeId,
        message: "Continue",
      },
      parent,
    );
    expect(response).toMatchObject({ success: false });
  });

  test("reports steered without passing a disconnect signal", async () => {
    const { parent } = fixture();
    let signal: AbortSignal | undefined;
    const response = await handleSubagentMessageCommand(
      {
        type: "subagent_message",
        request_id: "steer",
        runtime,
        agent_id: nativeId,
        message: "Change course",
      },
      parent,
      {
        sendClaude: async (options) => {
          signal = options.signal;
          return { mode: "steered", sessionId: nativeId };
        },
      },
    );
    expect(signal).toBeUndefined();
    expect(response).toMatchObject({ success: true, delivery: "steered" });
  });

  test("deduplicates a retried request ID", async () => {
    const { parent } = fixture();
    let calls = 0;
    const command = {
      type: "subagent_message" as const,
      request_id: "duplicate",
      runtime,
      agent_id: nativeId,
      message: "Only once",
    };
    const deps = {
      sendClaude: async () => {
        calls += 1;
        return { mode: "steered" as const, sessionId: nativeId };
      },
    };
    const [first, second] = await Promise.all([
      handleSubagentMessageCommand(command, parent, deps),
      handleSubagentMessageCommand(command, parent, deps),
    ]);
    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  test("delivers the same request ID from different parents", async () => {
    const { parent: firstParent } = fixture();
    const secondRuntime = { agent_id: "agent-b", conversation_id: "conv-b" };
    const secondParent = createConversationRuntime(
      createRuntime(),
      secondRuntime.agent_id,
      secondRuntime.conversation_id,
    );
    registerSubagent(
      "subagent-2",
      "claude-code",
      "Other work",
      "call-2",
      true,
      false,
      {
        agentId: secondRuntime.agent_id,
        conversationId: secondRuntime.conversation_id,
      },
    );
    updateSubagent("subagent-2", { agentId: nativeId, status: "running" });
    backgroundTasks.set("task-2", {
      description: "Other work",
      subagentType: "claude-code",
      subagentId: "subagent-2",
      status: "running",
      startTime: new Date(),
      outputFile: "/tmp/out-2",
      abortController: new AbortController(),
    });
    let calls = 0;
    const sendClaude = async () => {
      calls += 1;
      return { mode: "steered" as const, sessionId: nativeId };
    };
    const command = {
      type: "subagent_message" as const,
      request_id: "same-request",
      agent_id: nativeId,
      message: "Continue",
    };

    const [first, second] = await Promise.all([
      handleSubagentMessageCommand({ ...command, runtime }, firstParent, {
        sendClaude,
      }),
      handleSubagentMessageCommand(
        { ...command, runtime: secondRuntime },
        secondParent,
        { sendClaude },
      ),
    ]);

    expect(calls).toBe(2);
    expect(first).toMatchObject({ success: true });
    expect(second).toMatchObject({ success: true });
  });

  test("tracks resumed work with the caller tool call ID", async () => {
    const { parent } = fixture();
    let tracked: Record<string, unknown> | undefined;
    const completion = Promise.resolve({
      agentId: nativeId,
      success: true,
      report: "Done",
    } satisfies SubagentResult);
    const response = await handleSubagentMessageCommand(
      {
        type: "subagent_message",
        request_id: "resume",
        runtime,
        agent_id: nativeId,
        message: "Continue",
        tool_call_id: "follow-call",
      },
      parent,
      {
        sendClaude: async () => ({
          mode: "resumed",
          sessionId: nativeId,
          completion,
          interrupt: async () => {},
        }),
        track: ((args: Record<string, unknown>) => {
          tracked = args;
          return {
            taskId: "task-follow",
            outputFile: "/tmp/follow",
            subagentId: "subagent-follow",
          };
        }) as never,
      },
    );
    expect(response).toMatchObject({ success: true, delivery: "resumed" });
    expect(tracked).toMatchObject({
      toolCallId: "follow-call",
      publishResult: true,
    });
  });

  test("interrupts untracked resumed work and allows the request to retry", async () => {
    const { parent } = fixture();
    let interrupts = 0;
    let sends = 0;
    let captures = 0;
    const command = {
      type: "subagent_message" as const,
      request_id: "tracking-failure",
      runtime,
      agent_id: nativeId,
      message: "Continue",
    };
    const deps: NonNullable<
      Parameters<typeof handleSubagentMessageCommand>[2]
    > = {
      sendClaude: async (options) => {
        sends += 1;
        await options.beforeStart?.();
        return {
          mode: "resumed" as const,
          sessionId: nativeId,
          completion: Promise.resolve({
            agentId: nativeId,
            success: false,
            report: "Interrupted",
          } satisfies SubagentResult),
          interrupt: async () => {
            interrupts += 1;
          },
        };
      },
      reserveCapture: async () => ({
        capture: async () => {
          captures += 1;
        },
      }),
      track: (() => {
        throw new Error("tracking failed");
      }) as never,
    };

    const first = await handleSubagentMessageCommand(command, parent, deps);
    await Promise.resolve();
    const second = await handleSubagentMessageCommand(command, parent, deps);

    expect(first).toMatchObject({ success: false, error: "tracking failed" });
    expect(second).toMatchObject({ success: false, error: "tracking failed" });
    expect(interrupts).toBe(2);
    expect(sends).toBe(2);
    expect(captures).toBe(2);
  });

  test("stops the owning background task", async () => {
    const { parent, abortController } = fixture();
    const response = await handleSubagentStopCommand(
      {
        type: "subagent_stop",
        request_id: "stop",
        runtime,
        agent_id: nativeId,
      },
      parent,
    );
    expect(response).toMatchObject({ success: true, stopped: true });
    expect(abortController.signal.aborted).toBe(true);
  });
});
