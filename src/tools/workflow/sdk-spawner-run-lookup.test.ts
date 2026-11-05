import { expect, test } from "bun:test";
import {
  __testSetBackend,
  APIBackend,
  type APIClient,
  getBackend,
} from "@/backend";
import { createSdkSpawner } from "./sdk-spawner.ts";
import type { SdkClient, SdkQuery } from "./types.ts";

function completedQuery(): SdkQuery {
  return {
    conversationId: "conv-worker",
    agentId: null,
    async *[Symbol.asyncIterator]() {
      yield { type: "result" as const, success: true, result: "continued" };
    },
    async interrupt() {},
    close() {},
  };
}

test("finds the latest run when the last 100 messages have no run ID", async () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({
    id: `message-${index}`,
    run_id: null,
  }));
  const runQueries: unknown[] = [];
  let messageListCalls = 0;
  const apiClient = {
    conversations: {
      messages: {
        list: async () => {
          messageListCalls++;
          return { getPaginatedItems: () => messages };
        },
      },
    },
    runs: {
      list: async (query: unknown) => {
        runQueries.push(query);
        return {
          getPaginatedItems: () => [
            {
              id: "run-latest",
              conversation_id: "conv-worker",
              status: "completed",
              completed_at: "2026-10-26T00:00:00Z",
            },
          ],
        };
      },
    },
  } as unknown as APIClient;
  const originalBackend = getBackend();
  __testSetBackend(new APIBackend({ getClient: async () => apiClient }));

  try {
    const client: SdkClient = { query: completedQuery };
    const outcome = await createSdkSpawner(client, {
      parentAgentId: "agent-parent",
      model: "openai/gpt-5.6-luna",
      supportsAgentFreeResume: true,
      retrieveConversation: async () => ({
        agent_id: null,
        parent_agent_id: "agent-parent",
        model: "openai/gpt-5.6-luna",
      }),
    })(
      {
        prompt: "continue",
        options: { conversationId: "conv-worker" },
        callIndex: 0,
      },
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      value: "continued",
      conversationId: "conv-worker",
    });
    expect(messageListCalls).toBe(0);
    expect(runQueries).toEqual([
      { conversation_id: "conv-worker", order: "desc", limit: 1 },
    ]);
  } finally {
    __testSetBackend(originalBackend);
  }
});
