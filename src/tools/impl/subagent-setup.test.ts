import { expect, test } from "bun:test";
import {
  createInputAcceptanceWaiter,
  runSubagentSetup,
} from "./subagent-setup";

const child = { agentId: "agent-parent", conversationId: "conv-new" };

test("setup finishes before the caller can start the child", async () => {
  const order: string[] = [];
  const result = await runSubagentSetup({
    child,
    setup: {
      beforeStart: async (value) => {
        expect(value).toEqual(child);
        order.push("bound");
        return { start: true };
      },
    },
    deleteUnstartedFork: async () => {
      throw new Error("must not delete");
    },
  });
  if (result.start) order.push("start");
  expect(order).toEqual(["bound", "start"]);
});

test("a race loser is deleted before returning the existing worker", async () => {
  const deleted: string[] = [];
  expect(
    await runSubagentSetup({
      child,
      setup: {
        beforeStart: async () => ({
          start: false,
          result: "conv-winner",
          discardUnstartedFork: true,
        }),
      },
      deleteUnstartedFork: async (id) => {
        deleted.push(id);
      },
    }),
  ).toEqual({ start: false, result: "conv-winner" });
  expect(deleted).toEqual(["conv-new"]);
});

test("unknown setup failure retains the child and cannot start it", async () => {
  await expect(
    runSubagentSetup({
      child,
      setup: {
        beforeStart: async () => {
          throw new Error("controller disconnected after binding");
        },
      },
      deleteUnstartedFork: async () => {
        throw new Error("must not delete");
      },
    }),
  ).rejects.toThrow("controller disconnected");
});

test("cancellation after setup prevents launch without deleting an accepted binding", async () => {
  const abort = new AbortController();
  await expect(
    runSubagentSetup({
      child,
      signal: abort.signal,
      setup: {
        beforeStart: async () => {
          abort.abort(new Error("interrupted"));
          return { start: true };
        },
      },
      deleteUnstartedFork: async () => {
        throw new Error("must not delete");
      },
    }),
  ).rejects.toThrow("interrupted");
});

test("startup failure rejects the acceptance wait without making the worker usable", async () => {
  const waiter = createInputAcceptanceWaiter("initial-1", async () => {
    throw new Error("must not accept");
  });
  const waiting = waiter.wait();
  waiter.completed("computer offline");
  await expect(waiting).rejects.toThrow("computer offline");
});
