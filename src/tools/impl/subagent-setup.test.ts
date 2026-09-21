import { expect, test } from "bun:test";
import { runSubagentSetup } from "./subagent-setup";

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
  if (result === undefined) order.push("start");
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
  ).toBe("conv-winner");
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
