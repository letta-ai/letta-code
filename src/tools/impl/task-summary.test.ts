import { describe, expect, test } from "bun:test";
import { buildClaudeStreamArgs } from "./claude-stream-session";
import { recordTaskSummary, resolveTaskInput } from "./task-summary";

describe("task description as the scoped task", () => {
  test("a forked agent without a prompt takes the description as its assignment", () => {
    expect(
      resolveTaskInput({ description: "Fix websocket reconnect hang" }, true),
    ).toEqual({
      description: "Fix websocket reconnect hang",
      prompt: "Fix websocket reconnect hang",
    });
    expect(resolveTaskInput({ description: "Fix hang" }, false)).toEqual({
      error:
        "prompt is required unless the agent forks this conversation (fork_context)",
    });
    expect(resolveTaskInput({ prompt: "go" }, true)).toEqual({
      error: "description is required",
    });
  });

  test("writes the description as the new conversation's summary", async () => {
    const updates: Array<[string, unknown]> = [];
    const backend = {
      updateConversation: async (id: string, body: unknown) => {
        updates.push([id, body]);
        return {} as never;
      },
    };
    await recordTaskSummary(
      "conv-1",
      " Fix websocket reconnect hang ",
      backend,
    );
    await recordTaskSummary("default", "Ignored", backend);
    await recordTaskSummary(null, "Ignored", backend);
    await recordTaskSummary("conv-2", "Best effort", {
      updateConversation: async () => Promise.reject(new Error("down")),
    });
    expect(updates).toEqual([
      ["conv-1", { summary: "Fix websocket reconnect hang" }],
    ]);
  });

  test("names a new Claude Code session, not a resumed one", () => {
    const name = "Fix websocket reconnect hang";
    expect(
      buildClaudeStreamArgs({ sessionId: "s", sessionName: name }),
    ).toContain(name);
    expect(
      buildClaudeStreamArgs({ resumeSessionId: "s", sessionName: name }),
    ).not.toContain("--name");
  });
});
