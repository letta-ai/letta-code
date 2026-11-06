import { expect, test } from "bun:test";
import { executeToolScript } from "@/tools/workflow/workflow-engine";
import { canvasWatchScript } from "./watch-canvas";

test("polls the harness, emits only returned events, and sleeps between polls", async () => {
  const emitted: string[] = [];
  const calls: unknown[] = [];
  let polls = 0;
  let sleeps = 0;
  await expect(
    executeToolScript({
      script: canvasWatchScript,
      args: { canvas_id: "F1" },
      builtinToolNames: ["read_canvas"],
      listTools: async () => [],
      callTool: async (name, args) => {
        calls.push({ name, args });
        polls++;
        const events =
          polls === 2 ? [{ kind: "editing started", diff: "+hello" }] : [];
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ canvas_id: "F1", watch_events: events }),
            },
          ],
        };
      },
      globals: {
        emit: (text: string) => emitted.push(text),
        sleep: async (ms: number) => {
          expect(ms).toBe(10_000);
          if (++sleeps === 3) throw new Error("stop test");
        },
      },
    }),
  ).rejects.toThrow("stop test");
  expect(calls).toEqual(
    Array(3).fill({
      name: "read_canvas",
      args: { canvas_id: "F1", watch: true },
    }),
  );
  expect(emitted).toEqual(["Canvas F1: editing started\n+hello"]);
});

test("rejects a server without the watch contract instead of silently watching nothing", async () => {
  await expect(
    executeToolScript({
      script: canvasWatchScript,
      args: { canvas_id: "F1" },
      builtinToolNames: ["read_canvas"],
      listTools: async () => [],
      callTool: async () => ({
        content: [{ type: "text", text: JSON.stringify({ markdown: "hi" }) }],
      }),
    }),
  ).rejects.toThrow("does not support canvas watches");
});

test("retries a busy harness without repeating the same error notification", async () => {
  let calls = 0;
  let sleeps = 0;
  const emitted: string[] = [];
  await expect(
    executeToolScript({
      script: canvasWatchScript,
      args: { canvas_id: "F1" },
      builtinToolNames: ["read_canvas"],
      callTool: async () => {
        if (++calls <= 2) throw new Error("busy");
        return {
          content: [
            { type: "text", text: JSON.stringify({ watch_events: [] }) },
          ],
        };
      },
      globals: {
        emit: (text: string) => emitted.push(text),
        sleep: async () => {
          if (++sleeps === 3) throw new Error("stop test");
        },
      },
    }),
  ).rejects.toThrow("stop test");
  expect(calls).toBe(3);
  expect(emitted).toHaveLength(1);
  expect(emitted[0]).toContain("refresh failed; retrying");
});
