import { describe, expect, test } from "bun:test";
import {
  clearSubagentsByIds,
  registerSubagent,
  updateSubagent,
} from "@/agent/subagent-state";
import { waitForBackgroundSubagentLink } from "@/agent/subagents/background-link";
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

  test("records the summary when the conversation ID arrives after the agent URL", async () => {
    const id = crypto.randomUUID();
    registerSubagent(id, "general-purpose", "Fix reconnect hang");
    updateSubagent(id, { agentURL: "https://example.com/agents/agent-1" });
    const updates: Array<[string, unknown]> = [];
    try {
      const ready = waitForBackgroundSubagentLink(id, 500).then(
        (conversationId) => {
          return recordTaskSummary(conversationId, "Fix reconnect hang", {
            updateConversation: async (conversationId, body) => {
              updates.push([conversationId, body]);
              return { id: conversationId, agent_id: "agent-1" };
            },
          });
        },
      );
      await Bun.sleep(0);
      updateSubagent(id, { conversationId: "conv-1" });
      await ready;
      expect(updates).toEqual([["conv-1", { summary: "Fix reconnect hang" }]]);
    } finally {
      clearSubagentsByIds([id]);
    }
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
