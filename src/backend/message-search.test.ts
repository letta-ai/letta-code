import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentCreateBody,
  ConversationCreateBody,
  ConversationMessageCreateBody,
} from "@/backend";
import { LocalBackend } from "@/backend/local";
import {
  searchMessagesForBackend,
  warmMessageSearchCacheForBackend,
} from "@/backend/message-search";

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // drain
  }
}

function createBody(
  text: string,
  agentId: string,
): ConversationMessageCreateBody {
  return {
    messages: [{ role: "user", content: text }],
    streaming: true,
    stream_tokens: true,
    include_pings: true,
    background: true,
    client_tools: [],
    client_skills: [],
    agent_id: agentId,
  } as unknown as ConversationMessageCreateBody;
}

describe("message search backend routing", () => {
  test("searches local backend conversation history without API search", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-message-search-"));
    try {
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      const agent = await backend.createAgent({
        name: "Search Agent",
        model: "openai/gpt-test",
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);

      await drain(
        await backend.createConversationMessageStream(
          conversation.id,
          createBody("needle in local haystack", agent.id),
        ),
      );

      const results = await searchMessagesForBackend(
        {
          query: "needle haystack",
          agent_id: agent.id,
          search_mode: "hybrid",
          limit: 10,
        },
        backend,
      );

      expect(results.length).toBeGreaterThan(0);
      expect(JSON.stringify(results)).toContain("needle in local haystack");
      expect(results[0]?.agent_id).toBe(agent.id);
      expect(results[0]?.conversation_id).toBe(conversation.id);

      const warm = await warmMessageSearchCacheForBackend<{
        collection: string;
        status: string;
        warmed: boolean;
      }>({ collection: "messages", scope: {} }, backend);
      expect(warm).toEqual({
        collection: "messages",
        status: "local-backend-noop",
        warmed: false,
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
