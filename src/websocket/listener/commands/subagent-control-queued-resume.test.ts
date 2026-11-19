import { afterEach, expect, jest, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { SubagentResult } from "@/agent/subagents";
import {
  __resetCodexSessionsForTests,
  sendCodexMessage,
} from "@/tools/impl/codex-app-server";
import {
  clearNativeSessionCaptureForTests,
  rememberNativeSession,
} from "@/tools/impl/native-session-capture";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { createConversationRuntime } from "@/websocket/listener/runtime";
import {
  __resetSubagentControlDedupeForTests,
  handleSubagentMessageCommand,
} from "./subagent-control";

const runtime = { agent_id: "agent-a", conversation_id: "conv-a" };
const workerEnv = {
  resolveSecretEnv: async () => ({}),
  resolveMcpReminder: async () => undefined,
};

afterEach(async () => {
  jest.useRealTimers();
  __resetCodexSessionsForTests();
  __resetSubagentControlDedupeForTests();
  await clearNativeSessionCaptureForTests();
});

test.each(["environment setup", "thread/resume", "turn/start"])(
  "queues a follow-up during slow %s and still tracks the resumed turn",
  async (slowMethod) => {
    jest.useFakeTimers();
    const parent = createConversationRuntime(
      createRuntime(),
      runtime.agent_id,
      runtime.conversation_id,
    );
    const threadId = "22222222-2222-4222-8222-222222222222";
    const agentId = `codex_${threadId}`;
    rememberNativeSession(
      "codex",
      threadId,
      { agentId: runtime.agent_id, conversationId: runtime.conversation_id },
      "http://localhost:8283",
    );
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const release = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    const tracked = Promise.withResolvers<{
      completion: Promise<SubagentResult>;
    }>();
    const send = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
    let starts = 0;
    stdin.on("data", (chunk) => {
      const { id, method } = JSON.parse(chunk.toString());
      if (typeof id !== "number") return;
      let result = {};
      if (method === "thread/resume") result = { thread: { id: threadId } };
      if (method === "turn/start") {
        starts++;
        result = { turn: { id: "follow-up-turn" } };
      }
      if (method === slowMethod) {
        blocked.resolve();
        void release.promise.then(() => send({ id, result }));
      } else {
        send({ id, result });
      }
    });
    const command = {
      type: "subagent_message" as const,
      request_id: "slow-resume",
      runtime,
      agent_id: agentId,
      message: "Continue",
    };
    const deps: NonNullable<
      Parameters<typeof handleSubagentMessageCommand>[2]
    > = {
      workerEnv: {
        ...workerEnv,
        resolveMcpReminder: async () => {
          if (slowMethod === "environment setup") {
            blocked.resolve();
            await release.promise;
          }
          return undefined;
        },
      },
      sendCodex: (options) =>
        sendCodexMessage(options, {
          createTransport: () => ({ stdin, stdout }),
        }),
      reserveCapture: async () => ({ capture: async () => {} }),
      track: jest.fn(({ completion }) => {
        tracked.resolve({ completion });
        return {
          taskId: "follow-up",
          subagentId: "resumed",
          outputFile: "/tmp/follow-up",
        };
      }),
    };

    const response = handleSubagentMessageCommand(command, parent, deps);
    await blocked.promise;
    jest.advanceTimersByTime(10_000);
    // Flush the handler's promise continuations without releasing the RPC.
    const observed = await Promise.race([
      response,
      new Promise<undefined>((resolve) => setImmediate(resolve)),
    ]);
    try {
      expect(observed).toMatchObject({ success: true, delivery: "queued" });
      expect(deps.track).not.toHaveBeenCalled();
      jest.advanceTimersByTime(31_000);
      expect(observed).toEqual(
        await handleSubagentMessageCommand(command, parent, deps),
      );
    } finally {
      release.resolve();
    }

    const { completion } = await tracked.promise;
    send({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: "follow-up-turn",
          status: "completed",
          items: [{ type: "agentMessage", text: "Follow-up finished" }],
        },
      },
    });
    expect(await completion).toMatchObject({
      success: true,
      report: "Follow-up finished",
    });
    expect(starts).toBe(1);
    expect(deps.track).toHaveBeenCalledTimes(1);
    expect(observed).toEqual(
      await handleSubagentMessageCommand(command, parent, deps),
    );
  },
);
