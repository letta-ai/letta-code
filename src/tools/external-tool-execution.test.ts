import { expect, test } from "bun:test";
import { runExternalTool } from "./external-tool-execution";

test("passes cancellation and preserves controller errors", async () => {
  const controller = new AbortController();
  const result = await runExternalTool({
    toolCallId: "1",
    toolName: "read",
    input: {},
    tool: { name: "read" },
    signal: controller.signal,
    executor: async (_id, _name, _input, context) => {
      expect(context?.signal).toBe(controller.signal);
      return { content: [{ type: "text", text: "denied" }], isError: true };
    },
  });
  expect(result).toEqual({ status: "error", toolReturn: "denied" });
});

test("already aborted tools never call the executor", async () => {
  let called = false;
  const result = await runExternalTool({
    toolCallId: "1",
    toolName: "read",
    input: {},
    signal: AbortSignal.abort(new Error("cancelled")),
    executor: async () => {
      called = true;
      return { content: [], isError: false };
    },
  });
  expect(result.status).toBe("error");
  expect(called).toBe(false);
});
