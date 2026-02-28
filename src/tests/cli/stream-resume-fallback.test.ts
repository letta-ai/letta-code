import { describe, expect, test } from "bun:test";
import type { Run } from "@letta-ai/letta-client/resources/agents/messages";
import { discoverFallbackRunIdForResume } from "../../cli/helpers/stream";

function run(id: string, createdAt: string): Run {
  return {
    id,
    agent_id: "agent-test",
    created_at: createdAt,
    status: "running",
  };
}

describe("discoverFallbackRunIdForResume", () => {
  test("prefers newest conversation-scoped run created after request start", async () => {
    const runsList = async (query: {
      conversation_id?: string | null;
      agent_id?: string | null;
    }): Promise<Run[]> => {
      if (query.conversation_id === "conv-123") {
        return [
          run("run-mid", "2026-02-27T10:01:05.000Z"),
          run("run-new", "2026-02-27T10:01:10.000Z"),
        ];
      }
      return [];
    };

    const candidate = await discoverFallbackRunIdForResume(
      {
        runs: {
          list: runsList,
          retrieve: async () => {
            throw new Error("not used");
          },
          messages: {
            stream: async () => {
              throw new Error("not used");
            },
          },
        },
      } as never,
      {
        conversationId: "conv-123",
        resolvedConversationId: "conv-123",
        agentId: "agent-test",
        requestStartedAtMs: Date.parse("2026-02-27T10:01:00.000Z"),
      },
    );

    expect(candidate).toBe("run-new");
  });

  test("for default conversation falls back to agent lookup when conversation lookup misses", async () => {
    const calls: Array<{
      conversation_id?: string | null;
      agent_id?: string | null;
    }> = [];

    const runsList = async (query: {
      conversation_id?: string | null;
      agent_id?: string | null;
    }): Promise<Run[]> => {
      calls.push({
        conversation_id: query.conversation_id,
        agent_id: query.agent_id,
      });

      if (query.agent_id === "agent-test") {
        return [run("run-agent-fallback", "2026-02-27T11:00:05.000Z")];
      }

      return [];
    };

    const candidate = await discoverFallbackRunIdForResume(
      {
        runs: {
          list: runsList,
          retrieve: async () => {
            throw new Error("not used");
          },
          messages: {
            stream: async () => {
              throw new Error("not used");
            },
          },
        },
      } as never,
      {
        conversationId: "default",
        resolvedConversationId: "agent-test",
        agentId: "agent-test",
        requestStartedAtMs: Date.parse("2026-02-27T11:00:00.000Z"),
      },
    );

    expect(candidate).toBe("run-agent-fallback");
    expect(calls).toEqual([
      { conversation_id: "agent-test", agent_id: undefined },
      { conversation_id: undefined, agent_id: "agent-test" },
    ]);
  });

  test("returns null when all runs are older than request start", async () => {
    const runsList = async (): Promise<Run[]> => [
      run("run-old-1", "2026-02-27T09:59:58.000Z"),
      run("run-old-2", "2026-02-27T09:59:59.000Z"),
    ];

    const candidate = await discoverFallbackRunIdForResume(
      {
        runs: {
          list: runsList,
          retrieve: async () => {
            throw new Error("not used");
          },
          messages: {
            stream: async () => {
              throw new Error("not used");
            },
          },
        },
      } as never,
      {
        conversationId: "conv-abc",
        resolvedConversationId: "conv-abc",
        agentId: "agent-test",
        requestStartedAtMs: Date.parse("2026-02-27T10:00:00.000Z"),
      },
    );

    expect(candidate).toBeNull();
  });
});
