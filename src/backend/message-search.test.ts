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
} from "@/backend/local/local-transcript";
import { searchLocalTranscriptMessages } from "@/backend/local/transcript-search";
import {
  searchMessagesForBackend,
  warmMessageSearchCacheForBackend,
} from "@/backend/message-search";
import { runWithRuntimeContext } from "@/runtime-context";

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

async function writeLegacySearchTranscript(input: {
  storageDir: string;
  directory: string;
  conversationId: string;
  agentId?: string;
  hidden?: boolean;
  messages: unknown[];
}): Promise<void> {
  const conversationDir = join(
    input.storageDir,
    "conversations",
    input.directory,
  );
  await mkdir(conversationDir, { recursive: true });
  await writeFile(
    join(conversationDir, "conversation.json"),
    `${JSON.stringify({
      id: input.conversationId,
      agent_id: input.agentId ?? "agent-search",
      ...(input.hidden ? { hidden: true } : {}),
    })}\n`,
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
    `${input.messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  );
}

describe("message search backend routing", () => {
  test("local search rejects unsupported modes and defaults to FTS", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-message-search-"));
    try {
      await writeLegacySearchTranscript({
        storageDir,
        directory: "modes",
        conversationId: "conv-modes",
        messages: [
          { id: "needle", role: "user", content: "needle", timestamp: 1 },
        ],
      });
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      for (const mode of ["vector", "hybrid"]) {
        await expect(
          searchMessagesForBackend(
            { query: "needle", search_mode: mode },
            backend,
          ),
        ).rejects.toThrow(
          `Local backend does not support "${mode}" message search. Use "fts".`,
        );
      }
      const defaultResults = await searchMessagesForBackend(
        { query: "needle" },
        backend,
      );
      const ftsResults = await searchMessagesForBackend(
        { query: "needle", search_mode: "fts" },
        backend,
      );
      expect(defaultResults).toEqual(ftsResults);
      expect(defaultResults.map((result) => result.message_id)).toEqual([
        "needle",
      ]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

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
          search_mode: "fts",
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
          search_mode: "fts",
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
          search_mode: "fts",
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

  test("ranks partial token matches with BM25 and keeps quotes strict", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-message-search-"));
    try {
      await writeLegacySearchTranscript({
        storageDir,
        directory: "ranking",
        conversationId: "conv-ranking",
        messages: [
          {
            id: "best",
            role: "user",
            content: "Project Heliotrope uses a SQLite-migration guard.",
            timestamp: 1,
          },
          {
            id: "migration-only",
            role: "user",
            content: "The migration checklist covers backups.",
            timestamp: 2,
          },
          {
            id: "reversed-phrase",
            role: "user",
            content: "SQLite has a careful online migration plan.",
            timestamp: 3,
          },
          {
            id: "phrase-token-suffix",
            role: "user",
            content: "The notree pose is unrelated.",
            timestamp: 4,
          },
          {
            id: "phrase-token-exact",
            role: "user",
            content: "The tree pose is intentional.",
            timestamp: 5,
          },
        ],
      });

      const ranked = searchLocalTranscriptMessages(storageDir, {
        query: "heliotrope migration rollback",
        agent_id: "agent-search",
        limit: 10,
      });
      expect(ranked.map((result) => result.message_id)).toEqual([
        "best",
        "migration-only",
        "reversed-phrase",
      ]);

      const phraseResults = searchLocalTranscriptMessages(storageDir, {
        query: '"sqlite migration" rollback',
        agent_id: "agent-search",
        limit: 10,
      });
      expect(phraseResults.map((result) => result.message_id)).toEqual([
        "best",
      ]);

      const boundedPhraseResults = searchLocalTranscriptMessages(storageDir, {
        query: '"tree pose"',
        agent_id: "agent-search",
        limit: 10,
      });
      expect(boundedPhraseResults.map((result) => result.message_id)).toEqual([
        "phrase-token-exact",
      ]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("keeps unsegmented CJK searches discoverable", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-message-search-"));
    try {
      await writeLegacySearchTranscript({
        storageDir,
        directory: "cjk",
        conversationId: "conv-cjk",
        messages: [
          { id: "chinese", role: "user", content: "你好世界", timestamp: 1 },
          {
            id: "japanese",
            role: "user",
            content: "京都駅で会議",
            timestamp: 2,
          },
          { id: "version", role: "user", content: "版本v2发布", timestamp: 3 },
          { id: "model", role: "user", content: "使用GPT4模型", timestamp: 4 },
          { id: "suffix", role: "user", content: "notree世界", timestamp: 5 },
          {
            id: "computer",
            role: "user",
            content: "新しいコンピューターを購入",
            timestamp: 6,
          },
          {
            id: "shop",
            role: "user",
            content: "スーパーで買い物",
            timestamp: 7,
          },
        ],
      });
      for (const [query, id] of [
        ["京都", "japanese"],
        ["v2", "version"],
        ['"v2"', "version"],
        ["gpt4", "model"],
        ['"gpt4"', "model"],
        ["コンピューター", "computer"],
        ['"コンピューター"', "computer"],
      ] as const) {
        expect(
          searchLocalTranscriptMessages(storageDir, { query }).map(
            (result) => result.message_id,
          ),
        ).toEqual([id]);
      }
      for (const query of ["世界", '"世界"']) {
        expect(
          searchLocalTranscriptMessages(storageDir, { query }).map(
            (result) => result.message_id,
          ),
        ).toContain("chinese");
      }
      expect(
        searchLocalTranscriptMessages(storageDir, { query: '"tree"' }),
      ).toEqual([]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("search echoes do not alter historical BM25 corpus statistics", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-message-search-"));
    try {
      await writeLegacySearchTranscript({
        storageDir,
        directory: "history",
        conversationId: "conv-history",
        messages: [
          { id: "quartz", role: "user", content: "quartz", timestamp: 1 },
          {
            id: "orchid",
            role: "user",
            content: "orchid orchid",
            timestamp: 2,
          },
          { id: "other", role: "user", content: "unrelated", timestamp: 3 },
        ],
      });
      const historicalOrder = () =>
        searchLocalTranscriptMessages(storageDir, {
          query: "quartz orchid",
          limit: 100,
        })
          .filter((result) => result.conversation_id === "conv-history")
          .map((result) => result.message_id);
      const before = historicalOrder();
      expect(before).toEqual(["orchid", "quartz"]);
      await writeLegacySearchTranscript({
        storageDir,
        directory: "searches",
        conversationId: "conv-searches",
        messages: Array.from({ length: 12 }, (_, index) => [
          {
            id: `call-${index}`,
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: `search-${index}`,
                name: "exec_command",
                arguments: { cmd: "letta messages search --query orchid" },
              },
            ],
            timestamp: index * 2 + 4,
          },
          {
            id: `result-${index}`,
            role: "toolResult",
            toolCallId: `search-${index}`,
            toolName: "exec_command",
            content: [{ type: "text", text: "orchid ".repeat(100) }],
            isError: false,
            timestamp: index * 2 + 5,
          },
        ]).flat(),
      });
      expect(historicalOrder()).toEqual(before);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("demotes current recall echoes without dropping ordinary tool results", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-message-search-"));
    try {
      await writeLegacySearchTranscript({
        storageDir,
        directory: "history",
        conversationId: "conv-history",
        messages: [
          {
            id: "historical-answer",
            role: "user",
            content:
              "The orchid migration decision was dual writes with rollback checks.",
            timestamp: 1,
          },
          {
            id: "valuable-tool-result",
            role: "toolResult",
            toolCallId: "ordinary-tool",
            toolName: "Read",
            content: [{ type: "text", text: "orchid migration evidence" }],
            isError: false,
            timestamp: 2,
          },
        ],
      });
      await writeLegacySearchTranscript({
        storageDir,
        directory: "current",
        conversationId: "conv-current",
        messages: [
          {
            id: "current-question",
            role: "user",
            content: "orchid migration",
            timestamp: 3,
          },
          {
            id: "search-command",
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "search-call",
                name: "exec_command",
                arguments: {
                  cmd: 'letta messages search --query "orchid migration"',
                },
              },
            ],
            timestamp: 4,
          },
          {
            id: "search-output",
            role: "toolResult",
            toolCallId: "search-call",
            toolName: "Bash",
            content: [{ type: "text", text: "orchid migration" }],
            isError: false,
            timestamp: 5,
          },
        ],
      });

      const backend = {
        capabilities: { localModelCatalog: true },
        getLocalStorageDir: () => storageDir,
      } as unknown as LocalBackend;
      const results = await runWithRuntimeContext(
        { conversationId: "conv-current" },
        () =>
          searchMessagesForBackend(
            { query: "orchid migration", agent_id: "agent-search", limit: 10 },
            backend,
          ),
      );
      expect(results[0]?.message_id).toBe("valuable-tool-result");
      expect(results[1]?.message_id).toBe("historical-answer");
      expect(results.map((result) => result.message_id)).toContain(
        "current-question",
      );

      const explicitlyScoped = searchLocalTranscriptMessages(
        storageDir,
        {
          query: "orchid migration",
          agent_id: "agent-search",
          conversation_id: "conv-current",
          limit: 10,
        },
        { currentConversationId: "conv-current" },
      );
      expect(explicitlyScoped[0]?.message_id).toBe("current-question");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
