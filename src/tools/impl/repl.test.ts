import { afterEach, beforeEach, expect, test } from "bun:test";
import { ReplSession } from "@/tools/repl/repl-session";
import type { SubagentOutcome } from "@/tools/workflow/types";
import {
  clearPendingMessages,
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import {
  __setReplSessionFactoryForTests,
  closeAllReplSessions,
  repl,
} from "./repl";

const scopeA = { agentId: "agent-test", conversationId: "conv-a" };
const scopeB = { agentId: "agent-test", conversationId: "conv-b" };
let queued: QueuedMessage[];
let finishTurn: ((value: unknown) => void) | undefined;

beforeEach(() => {
  queued = [];
  setMessageQueueAdder((message) => queued.push(message));
  __setReplSessionFactoryForTests(
    (_args, onWorkerSettled) =>
      new ReplSession({
        createSpawner: async () => ({
          spawner: (request, _signal, hooks) =>
            new Promise<SubagentOutcome>((resolve) => {
              const conversationId =
                request.options.conversationId ?? "conv-worker";
              hooks?.onStarted?.(conversationId);
              finishTurn = (value) =>
                resolve({ value, failed: false, conversationId });
            }),
          cleanup: async () => {},
        }),
        onWorkerSettled,
      }),
  );
});

afterEach(async () => {
  await closeAllReplSessions();
  __setReplSessionFactoryForTests(null);
  setMessageQueueAdder(null);
  clearPendingMessages();
  finishTurn = undefined;
});

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function parsed(result: { content: string }) {
  return JSON.parse(result.content) as {
    result: unknown;
    workers?: unknown[];
  };
}

test("sessions persist per conversation and reset clears them", async () => {
  await repl({ code: "x = 41;", parentScope: scopeA });
  expect(
    parsed(await repl({ code: "return x + 1;", parentScope: scopeA })).result,
  ).toBe(42);
  expect(
    parsed(await repl({ code: "return typeof x;", parentScope: scopeB }))
      .result,
  ).toBe("undefined");

  const reset = await repl({ reset: true, parentScope: scopeA });
  expect(reset.content).toBe("Repl session reset; its workers were stopped.");
  expect(
    parsed(await repl({ code: "return typeof x;", parentScope: scopeA }))
      .result,
  ).toBe("undefined");
});

test("a worker that finishes between cells notifies the conversation", async () => {
  const started = parsed(
    await repl({
      code: "w = agent.start('Review the diff', { label: 'review' }); return w.id;",
      parentScope: scopeA,
    }),
  );
  expect(started).toMatchObject({
    result: "w1",
    workers: [{ id: "w1", label: "review", status: "running" }],
  });
  await until(() => finishTurn !== undefined);
  finishTurn?.("looks good");
  await until(() => queued.length > 0);
  const notification = queued.find((message) =>
    message.text.includes("<task-id>repl_w1</task-id>"),
  );
  expect(notification?.text).toContain("<status>completed</status>");
  expect(notification?.text).toContain("looks good");
  expect(notification).toMatchObject({ conversationId: "conv-a" });
});

test("a long cell yields to the background and notifies on completion", async () => {
  const result = await repl({
    code: "return await agent('Slow task');",
    parentScope: scopeA,
    foregroundYieldMs: 10,
  });
  expect(result.content).toContain("Repl cell is still running");
  await until(() => finishTurn !== undefined);
  finishTurn?.("slow result");
  await until(() => queued.length > 0);
  expect(queued).toHaveLength(1);
  expect(queued[0]?.text).toContain("Repl cell completed");
  expect(queued[0]?.text).toContain("slow result");
});
