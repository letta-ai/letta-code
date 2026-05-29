import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentCreateBody,
  ConversationCreateBody,
  ConversationMessageCreateBody,
} from "@/backend";
import { LocalBackend } from "@/backend/local";
import { emptyLocalUsage } from "@/backend/local/local-message";
import {
  LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT,
  LOCAL_TRANSCRIPT_LEGACY_SCHEMA_VERSION,
  LOCAL_TRANSCRIPT_PROVIDER_STACK,
} from "@/backend/local/local-store";
import { searchLocalTranscriptMessages } from "@/backend/local/transcript-search";
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

      const conversationScopedResults = await searchMessagesForBackend(
        {
          query: "needle",
          agent_id: agent.id,
          conversation_id: conversation.id,
          search_mode: "fts",
          limit: 10,
        },
        backend,
      );
      expect(conversationScopedResults.length).toBeGreaterThan(0);
      expect(
        conversationScopedResults.every(
          (result) => result.conversation_id === conversation.id,
        ),
      ).toBe(true);

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

  test("searches durable local transcripts after compaction", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-message-search-"));
    try {
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
        complete: async () =>
          ({
            role: "assistant",
            content: [
              {
                type: "text",
                text: "COMPACTED SUMMARY WITHOUT OLD NEEDLE",
              },
            ],
            api: "openai-responses",
            provider: "openai",
            model: "gpt-5-mini",
            responseId: "summary-response",
            usage: emptyLocalUsage(),
            stopReason: "stop",
            timestamp: Date.now(),
          }) as never,
      });
      const agent = await backend.createAgent({
        name: "Compaction Search Agent",
        model: "openai/gpt-5-mini",
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);

      await drain(
        await backend.createConversationMessageStream(
          conversation.id,
          createBody("LOCAL_DURABLE_OLD_NEEDLE before compaction", agent.id),
        ),
      );
      await drain(
        await backend.createConversationMessageStream(
          conversation.id,
          createBody("LOCAL_DURABLE_KEEPER before compaction", agent.id),
        ),
      );

      await backend.compactConversationMessages(conversation.id, {
        agent_id: agent.id,
      } as never);

      const oldMessageResults = await searchMessagesForBackend(
        {
          query: "LOCAL_DURABLE_OLD_NEEDLE",
          agent_id: agent.id,
          conversation_id: conversation.id,
          search_mode: "hybrid",
          limit: 10,
        },
        backend,
      );
      expect(oldMessageResults.length).toBeGreaterThan(0);
      expect(JSON.stringify(oldMessageResults)).toContain(
        "LOCAL_DURABLE_OLD_NEEDLE",
      );

      const summaryResults = await searchMessagesForBackend(
        {
          query: "COMPACTED SUMMARY",
          agent_id: agent.id,
          conversation_id: conversation.id,
          search_mode: "vector",
          limit: 10,
        },
        backend,
      );
      expect(summaryResults.length).toBeGreaterThan(0);
      expect(JSON.stringify(summaryResults)).toContain("COMPACTED SUMMARY");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("excludes hidden fork conversations from local search", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-message-search-"));
    try {
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      const agent = await backend.createAgent({
        name: "Hidden Fork Search Agent",
        model: "openai/gpt-test",
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);
      await drain(
        await backend.createConversationMessageStream(
          conversation.id,
          createBody("LOCAL_HIDDEN_FORK_NEEDLE", agent.id),
        ),
      );

      const forked = await backend.forkConversation(conversation.id, {
        agentId: agent.id,
        hidden: true,
      });

      const results = await searchMessagesForBackend(
        {
          query: "LOCAL_HIDDEN_FORK_NEEDLE",
          agent_id: agent.id,
          search_mode: "fts",
          limit: 20,
        },
        backend,
      );

      expect(results.length).toBeGreaterThan(0);
      expect(
        results.some((result) => result.conversation_id === forked.id),
      ).toBe(false);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("requires agent scope for default conversation local transcript search", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-message-search-"));
    try {
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      const agentA = await backend.createAgent({
        name: "Default Search Agent A",
        model: "openai/gpt-test",
      } as AgentCreateBody);
      const agentB = await backend.createAgent({
        name: "Default Search Agent B",
        model: "openai/gpt-test",
      } as AgentCreateBody);

      await drain(
        await backend.createConversationMessageStream(
          "default",
          createBody("LOCAL_DEFAULT_SCOPE_NEEDLE agent a", agentA.id),
        ),
      );
      await drain(
        await backend.createConversationMessageStream(
          "default",
          createBody("LOCAL_DEFAULT_SCOPE_NEEDLE agent b", agentB.id),
        ),
      );

      const unscopedDefaultResults = await searchMessagesForBackend(
        {
          query: "LOCAL_DEFAULT_SCOPE_NEEDLE",
          conversation_id: "default",
          search_mode: "fts",
          limit: 10,
        },
        backend,
      );
      expect(unscopedDefaultResults).toHaveLength(0);

      const scopedDefaultResults = await searchMessagesForBackend(
        {
          query: "LOCAL_DEFAULT_SCOPE_NEEDLE",
          agent_id: agentA.id,
          conversation_id: "default",
          search_mode: "fts",
          limit: 10,
        },
        backend,
      );
      expect(scopedDefaultResults.length).toBeGreaterThan(0);
      expect(
        scopedDefaultResults.every((result) => result.agent_id === agentA.id),
      ).toBe(true);
      expect(JSON.stringify(scopedDefaultResults)).toContain("agent a");
      expect(JSON.stringify(scopedDefaultResults)).not.toContain("agent b");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("searches legacy local transcript rows with date filters", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-message-search-"));
    try {
      const conversationDir = join(storageDir, "conversations", "legacy");
      await mkdir(conversationDir, { recursive: true });
      await writeFile(
        join(conversationDir, "conversation.json"),
        `${JSON.stringify({ id: "legacy-conv", agent_id: "agent-legacy" })}\n`,
      );
      await writeFile(
        join(conversationDir, "manifest.json"),
        `${JSON.stringify({
          schema_version: LOCAL_TRANSCRIPT_LEGACY_SCHEMA_VERSION,
          message_format: LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT,
          provider_stack: LOCAL_TRANSCRIPT_PROVIDER_STACK,
          created_at: "2026-01-01T00:00:00.000Z",
        })}\n`,
      );
      await writeFile(
        join(conversationDir, "messages.jsonl"),
        `${JSON.stringify({
          id: "legacy-msg-1",
          role: "user",
          content: "LEGACY_LOCAL_NEEDLE",
          timestamp: Date.parse("2026-01-02T00:00:00.000Z"),
          metadata: {
            created_at: "2026-01-02T00:00:00.000Z",
            agent_id: "agent-legacy",
            conversation_id: "legacy-conv",
          },
        })}\n`,
      );

      const results = searchLocalTranscriptMessages(storageDir, {
        query: "LEGACY_LOCAL_NEEDLE",
        agent_id: "agent-legacy",
        conversation_id: "legacy-conv",
        limit: 10,
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.message_id).toBe("legacy-msg-1");

      const futureResults = searchLocalTranscriptMessages(storageDir, {
        query: "LEGACY_LOCAL_NEEDLE",
        agent_id: "agent-legacy",
        start_date: "2027-01-01T00:00:00.000Z",
        limit: 10,
      });
      expect(futureResults).toHaveLength(0);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
